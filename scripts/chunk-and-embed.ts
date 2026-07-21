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
import { chunkAndEmbed, createEmbeddingProviderFromEnv } from '../packages/ingestion/dist/index.js';
import { createObjectStorageFromEnv } from '../packages/storage/dist/factory.js';
import type { ObjectStorage } from '../packages/storage/dist/object-storage.js';
import { requiredEnv } from './lib/cli.ts';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createObjectStorageFromEnv(process.env);
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
  private storage: ObjectStorage;
  private sourceType: SourceType | undefined;
  constructor(
    sql: postgres.Sql,
    storage: ObjectStorage,
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
        rd.logical_source_id AS "logicalSourceId",
        rd.parsed_uri AS "parsedUri",
        rd.parser_artifact_hash AS "parserArtifactHash",
        rd.parser_version_id::text AS "parserVersionId"
      FROM public.raw_documents rd
      WHERE rd.project_id = ${input.projectId}
        AND rd.ingest_status IN ('parsed', 'indexed')
        AND rd.parsed_uri IS NOT NULL
        AND (${this.sourceType ?? null}::text IS NULL OR rd.source_type = ${this.sourceType ?? null})
        AND NOT EXISTS (
          SELECT 1
          FROM public.raw_documents newer
          WHERE newer.project_id = rd.project_id
            AND newer.source_type = rd.source_type
            AND newer.logical_source_id = rd.logical_source_id
            AND newer.ingest_status IN ('parsed', 'indexed')
            AND newer.parsed_uri IS NOT NULL
            AND (newer.created_at, newer.id) > (rd.created_at, rd.id)
        )
        AND (
          ${this.dataSourceId ?? null}::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM public.raw_document_data_sources rdds
            WHERE rdds.raw_document_id = rd.id
              AND rdds.data_source_id = ${this.dataSourceId ?? null}::uuid
              AND rdds.project_id = ${input.projectId}
          )
        )
      ORDER BY
        rd.ingest_status DESC,
        rd.parsed_at NULLS LAST,
        rd.fetched_at,
        rd.id
      LIMIT ${input.limit}
    `) as Array<Omit<ChunkEmbeddingTarget, 'parsed'> & { parsedUri: string }>;

    return Promise.all(
      rows.map(
        async (row): Promise<ChunkEmbeddingTarget> => ({
          logicalSourceId: row.logicalSourceId,
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
          logical_source_id,
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
          ${input.logicalSourceId},
          ${input.docType},
          ${input.title},
          ${input.summary ?? null},
          ${input.canonicalUri},
          ${input.occurredAt},
          ${input.graphNodeId},
          ${this.sql.json(input.metadata as postgres.JSONValue)}
        )
        ON CONFLICT (project_id, doc_type, logical_source_id)
        DO UPDATE SET
          updated_at = documents.updated_at
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

  async activateDocumentVersion(input: {
    document: UpsertDocumentInput;
    documentId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (transaction: postgres.TransactionSql): Promise<boolean> => {
      if (
        !(await lockLatestProcessableDocumentVersion(transaction, input.documentId, input.document))
      ) {
        return false;
      }
      await updateDocumentVersion(transaction, input.documentId, input.document);
      await markRawVersionIndexed(transaction, input.document.rawDocumentId);
      return true;
    });
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

  async replaceDocumentChunks(input: ReplaceDocumentChunksInput): Promise<boolean> {
    return this.sql.begin(async (transaction: postgres.TransactionSql): Promise<boolean> => {
      if (
        !(await lockLatestProcessableDocumentVersion(transaction, input.documentId, input.document))
      ) {
        return false;
      }
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
          document.raw_document_id,
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
        JOIN public.documents document ON document.id = dc.document_id
        WHERE dc.project_id = ${input.projectId}
          AND dc.document_id = ${input.documentId}
      `;
      await updateDocumentVersion(transaction, input.documentId, input.document);
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
      await markRawVersionIndexed(transaction, input.rawDocumentId);
      return true;
    });
  }
}

async function lockLatestProcessableDocumentVersion(
  transaction: postgres.TransactionSql,
  documentId: string,
  input: UpsertDocumentInput,
): Promise<boolean> {
  const lockedDocuments = await transaction`
    SELECT id
    FROM public.documents
    WHERE id = ${documentId}
      AND project_id = ${input.projectId}
    FOR UPDATE
  `;
  if (lockedDocuments.length !== 1) {
    return false;
  }

  const latestTargets = await transaction`
    SELECT target.id
    FROM public.raw_documents target
    WHERE target.id = ${input.rawDocumentId}
      AND target.project_id = ${input.projectId}
      AND target.logical_source_id = ${input.logicalSourceId}
      AND target.ingest_status IN ('parsed', 'indexed')
      AND target.parsed_uri IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.raw_documents newer
        WHERE newer.project_id = target.project_id
          AND newer.source_type = target.source_type
          AND newer.logical_source_id = target.logical_source_id
          AND newer.ingest_status IN ('parsed', 'indexed')
          AND newer.parsed_uri IS NOT NULL
          AND (newer.created_at, newer.id) > (target.created_at, target.id)
      )
  `;
  return latestTargets.length === 1;
}

async function updateDocumentVersion(
  transaction: postgres.TransactionSql,
  documentId: string,
  input: UpsertDocumentInput,
): Promise<void> {
  await transaction`
    UPDATE public.documents
    SET
      raw_document_id = ${input.rawDocumentId},
      logical_source_id = ${input.logicalSourceId},
      doc_type = ${input.docType},
      title = ${input.title},
      summary = ${input.summary ?? null},
      canonical_uri = ${input.canonicalUri},
      occurred_at = ${input.occurredAt},
      graph_node_id = ${input.graphNodeId},
      metadata = ${transaction.json(input.metadata as postgres.JSONValue)},
      updated_at = now()
    WHERE id = ${documentId}
      AND project_id = ${input.projectId}
  `;
}

async function markRawVersionIndexed(
  transaction: postgres.TransactionSql,
  rawDocumentId: string,
): Promise<void> {
  await transaction`
    UPDATE public.raw_documents
    SET ingest_status = 'indexed', indexed_at = now(), ingest_error = null
    WHERE id = ${rawDocumentId}
  `;
  await transaction`
    UPDATE public.ingestion_queue
    SET status = 'indexed', last_error = null
    WHERE raw_document_id = ${rawDocumentId}
  `;
}

function createEmbeddingProvider(options: { embeddingProvider?: string }): EmbeddingProvider {
  return createEmbeddingProviderFromEnv({
    defaultProvider: 'deterministic',
    env: process.env,
    provider: options.embeddingProvider,
  });
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
