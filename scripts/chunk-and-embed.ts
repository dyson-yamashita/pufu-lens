import postgres from 'postgres';
import type { ChunkEmbeddingProjectRecord } from '../packages/ingestion/dist/chunk-embedding.js';
import type {
  ChunkEmbeddingRepository,
  ChunkEmbeddingTarget,
  DocumentChunkRecord,
  DocumentRecord,
  EmbeddingProvider,
  ReplaceDocumentChunksInput,
  SourceType,
  UpsertDocumentInput,
} from '../packages/ingestion/dist/index.js';
import {
  chunkAndEmbed,
  createDeterministicEmbeddingProvider,
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';
import { requiredEnv } from './lib/cli.ts';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresChunkEmbeddingRepository(
    sql,
    storage,
    options.source,
    options.dataSourceId,
  );
  const embeddingProvider = createEmbeddingProvider(options);

  try {
    const result = await chunkAndEmbed({
      dryRun: options.dryRun ?? false,
      embeddingProvider,
      limit: options.limit ?? 10,
      projectSlug,
      repository,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresChunkEmbeddingRepository implements ChunkEmbeddingRepository {
  private dataSourceId: string | undefined;
  private sql: postgres.Sql;
  private storage: LocalFsObjectStorage;
  private sourceType: SourceType | undefined;
  constructor(
    sql: postgres.Sql,
    storage: LocalFsObjectStorage,
    sourceType: SourceType | undefined,
    dataSourceId: string | undefined,
  ) {
    this.dataSourceId = dataSourceId;
    this.sql = sql;
    this.storage = storage;
    this.sourceType = sourceType;
  }

  async lookupProjectBySlug(slug: string): Promise<ChunkEmbeddingProjectRecord | undefined> {
    return singleJson(
      (await this.sql`
        SELECT id::text AS id, slug
        FROM public.projects
        WHERE slug = ${slug}
      `) as ChunkEmbeddingProjectRecord[],
    );
  }

  async readParsedDocuments(input: {
    limit: number;
    projectId: string;
  }): Promise<ChunkEmbeddingTarget[]> {
    const rows = (await this.sql`
      SELECT
        rd.content_hash AS "rawContentHash",
        rd.id::text AS "rawDocumentId",
        rd.parsed_uri AS "parsedUri",
        rd.parser_artifact_hash AS "parserArtifactHash",
        rd.parser_version_id::text AS "parserVersionId"
      FROM public.raw_documents rd
      WHERE rd.project_id = ${input.projectId}
        AND rd.ingest_status IN ('parsed', 'indexed')
        AND rd.parsed_uri IS NOT NULL
        AND (${this.sourceType ?? null}::text IS NULL OR rd.source_type = ${this.sourceType ?? null})
        AND (
          ${this.dataSourceId ?? null}::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.raw_document_data_sources rdds
            WHERE rdds.raw_document_id = rd.id
              AND rdds.data_source_id = ${this.dataSourceId ?? null}::uuid
          )
        )
      ORDER BY rd.parsed_at NULLS LAST, rd.fetched_at, rd.id
      LIMIT ${input.limit}
    `) as Array<Omit<ChunkEmbeddingTarget, 'parsed'> & { parsedUri: string }>;

    return Promise.all(
      rows.map(
        async (row): Promise<ChunkEmbeddingTarget> => ({
          parsed: await this.storage.getText(row.parsedUri),
          parsedUri: row.parsedUri,
          parserArtifactHash: row.parserArtifactHash,
          parserVersionId: row.parserVersionId,
          rawContentHash: row.rawContentHash,
          rawDocumentId: row.rawDocumentId,
        }),
      ),
    );
  }

  async upsertDocument(input: UpsertDocumentInput): Promise<DocumentRecord> {
    const document = singleJson(
      (await this.sql`
        INSERT INTO public.documents (
          project_id,
          raw_document_id,
          doc_type,
          title,
          summary,
          canonical_uri,
          occurred_at,
          graph_node_id,
          metadata
        )
        VALUES (
          ${input.projectId},
          ${input.rawDocumentId},
          ${input.docType},
          ${input.title},
          ${input.summary ?? null},
          ${input.canonicalUri},
          ${input.occurredAt},
          ${input.graphNodeId},
          ${this.sql.json(input.metadata as postgres.JSONValue)}
        )
        ON CONFLICT (raw_document_id)
        DO UPDATE SET
          doc_type = EXCLUDED.doc_type,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          canonical_uri = EXCLUDED.canonical_uri,
          occurred_at = EXCLUDED.occurred_at,
          graph_node_id = EXCLUDED.graph_node_id,
          metadata = EXCLUDED.metadata
        RETURNING
          doc_type AS "docType",
          graph_node_id AS "graphNodeId",
          id::text AS id,
          project_id::text AS "projectId",
          raw_document_id::text AS "rawDocumentId"
      `) as DocumentRecord[],
    );

    if (!document) {
      throw new Error(`Failed to upsert document for raw document: ${input.rawDocumentId}`);
    }
    return document;
  }

  async listCurrentChunks(input: {
    documentId: string;
    projectId: string;
  }): Promise<DocumentChunkRecord[]> {
    return (await this.sql`
      SELECT
        chunk_index AS "chunkIndex",
        content_hash AS "contentHash",
        embedding_model AS "embeddingModel",
        id::text AS id
      FROM public.document_chunks
      WHERE project_id = ${input.projectId}
        AND document_id = ${input.documentId}
      ORDER BY chunk_index
    `) as DocumentChunkRecord[];
  }

  async replaceDocumentChunks(input: ReplaceDocumentChunksInput): Promise<void> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<void> => {
      await transaction`
        INSERT INTO public.document_chunk_history (
          project_id,
          document_id,
          raw_document_id,
          previous_chunk_id,
          chunk_index,
          content,
          content_hash,
          embedding,
          embedding_model,
          metadata,
          archive_reason,
          superseded_by_raw_document_id,
          superseded_by_content_hash
        )
        SELECT
          dc.project_id,
          dc.document_id,
          ${input.rawDocumentId},
          dc.id,
          dc.chunk_index,
          dc.content,
          dc.content_hash,
          dc.embedding,
          dc.embedding_model,
          dc.metadata,
          ${input.archiveReason},
          ${input.rawDocumentId},
          ${input.supersededByContentHash}
        FROM public.document_chunks dc
        WHERE dc.project_id = ${input.projectId}
          AND dc.document_id = ${input.documentId}
      `;
      await transaction`
        DELETE FROM public.document_chunks
        WHERE project_id = ${input.projectId}
          AND document_id = ${input.documentId}
      `;
      for (const chunk of input.chunks) {
        await transaction`
          INSERT INTO public.document_chunks (
            project_id,
            document_id,
            chunk_index,
            content,
            content_hash,
            embedding,
            embedding_model,
            metadata
          )
          VALUES (
            ${input.projectId},
            ${input.documentId},
            ${chunk.chunkIndex},
            ${chunk.content},
            ${chunk.contentHash},
            ${vectorLiteral(chunk.embedding)},
            ${chunk.embeddingModel},
            ${transaction.json(chunk.metadata as postgres.JSONValue)}
          )
        `;
      }
      await transaction`
        UPDATE public.raw_documents
        SET ingest_status = 'indexed', indexed_at = now(), ingest_error = null
        WHERE id = ${input.rawDocumentId}
      `;
      await transaction`
        UPDATE public.ingestion_queue
        SET status = 'indexed', last_error = null
        WHERE raw_document_id = ${input.rawDocumentId}
      `;
    });
  }
}

function createEmbeddingProvider(options: { embeddingProvider?: string }): EmbeddingProvider {
  if ((options.embeddingProvider ?? 'deterministic') === 'deterministic') {
    return createDeterministicEmbeddingProvider();
  }
  if (options.embeddingProvider === 'gemini') {
    return createGeminiEmbeddingProvider({
      apiKey: requiredEnv('GEMINI_API_KEY'),
      dimensions: readDimensionsEnv(),
      model: process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_GEMINI_EMBEDDING_MODEL,
    });
  }
  throw new Error(`Unknown embedding provider: ${options.embeddingProvider}`);
}

function parseArgs(argv: string[]): {
  dataSourceId?: string;
  project?: string;
  source?: SourceType;
  limit?: number;
  embeddingProvider?: string;
  dryRun?: boolean;
} {
  const options: {
    dataSourceId?: string;
    project?: string;
    source?: SourceType;
    limit?: number;
    embeddingProvider?: string;
    dryRun?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--data-source-id') {
      options.dataSourceId = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      options.source = readSourceType(readOptionValue(argv, ++index, arg));
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--embedding-provider') {
      options.embeddingProvider = readOptionValue(argv, ++index, arg);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readSourceType(value: string): SourceType {
  if (!(SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported --source value: ${value}`);
  }
  return value as SourceType;
}

function createLocalObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalFsObjectStorage {
  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required.');
  }
  return new LocalFsObjectStorage(root);
}

function readDimensionsEnv(): number {
  const value = process.env.GEMINI_EMBEDDING_DIMENSIONS;
  if (!value) {
    throw new Error('GEMINI_EMBEDDING_DIMENSIONS is required.');
  }
  return readPositiveInteger(value, 'GEMINI_EMBEDDING_DIMENSIONS');
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function singleJson<T>(rows: T[]): T | undefined {
  return rows[0];
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
