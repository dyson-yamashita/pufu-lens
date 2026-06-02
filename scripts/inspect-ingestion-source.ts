import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { parseRawContent, validateParsedDocument } from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sourceType = requiredOption(options.source, '--source');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();

  try {
    const project = await lookupProject(sql, projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    const rows = await readRows({
      limit: options.limit ?? 10,
      projectId: project.id,
      sourceType,
      sql,
    });
    const documents = [];
    for (const row of rows) {
      documents.push(await inspectRow({ row, storage }));
    }

    const result = {
      documents,
      format: options.format ?? 'json',
      project: { id: project.id, slug: project.slug },
      source: sourceType,
      summary: summarize(documents),
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

async function readRows(input: any): Promise<any> {
  return input.sql`
    SELECT
      rd.byte_size AS "byteSize",
      rd.content_hash AS "contentHash",
      d.canonical_uri AS "documentCanonicalUri",
      d.doc_type AS "documentType",
      d.id::text AS "documentId",
      d.title AS "documentTitle",
      rd.fetched_at AS "fetchedAt",
      rd.hold_reason AS "holdReason",
      rd.id::text AS "rawDocumentId",
      rd.ingest_error AS "ingestError",
      rd.ingest_status AS "ingestStatus",
      rd.metadata,
      rd.mime_type AS "mimeType",
      rd.parsed_uri AS "parsedUri",
      rd.parser_artifact_hash AS "parserArtifactHash",
      rd.parser_version_id::text AS "parserVersionId",
      q.attempts AS "queueAttempts",
      q.hold_reason AS "queueHoldReason",
      q.last_error AS "queueLastError",
      q.status AS "queueStatus",
      rd.sanitized_sample_uri AS "sanitizedSampleUri",
      rd.source_id AS "sourceId",
      rd.source_type AS "sourceType",
      rd.source_uri AS "sourceUri",
      rd.storage_uri AS "storageUri"
    FROM public.raw_documents rd
    LEFT JOIN public.ingestion_queue q ON q.raw_document_id = rd.id
    LEFT JOIN public.documents d ON d.raw_document_id = rd.id
    WHERE rd.project_id = ${input.projectId}
      AND rd.source_type = ${input.sourceType}
    ORDER BY rd.fetched_at DESC, rd.id
    LIMIT ${input.limit}
  `;
}

async function inspectRow(input: any): Promise<any> {
  const rawText = await safeReadText(input.storage, input.row.storageUri);
  const actualContentHash = rawText === undefined ? null : sha256Hex(rawText);
  const parsed = input.row.parsedUri
    ? await safeReadParsed(input.storage, input.row.parsedUri)
    : null;
  const parsedFromRaw = rawText === undefined ? null : parseRawSafely(input.row, rawText);
  const sourceContract = validateSourceContract({
    actualContentHash,
    parsed,
    parsedFromRaw,
    row: input.row,
  });

  return {
    content: {
      actualContentHash,
      byteSize: input.row.byteSize === null ? null : Number(input.row.byteSize),
      contentHashMatchesStorage: actualContentHash === input.row.contentHash,
      mimeType: input.row.mimeType,
      storageReadable: rawText !== undefined,
      storageUri: input.row.storageUri,
    },
    document: input.row.documentId
      ? {
          canonicalUri: input.row.documentCanonicalUri,
          docType: input.row.documentType,
          id: input.row.documentId,
          title: input.row.documentTitle,
        }
      : null,
    parser: {
      artifactHash: input.row.parserArtifactHash,
      parsedReadable: parsed !== null,
      parsedUri: input.row.parsedUri,
      parserVersionId: input.row.parserVersionId,
    },
    queue: {
      attempts: input.row.queueAttempts,
      holdReason: input.row.queueHoldReason,
      lastError: sanitizeNullable(input.row.queueLastError),
      status: input.row.queueStatus,
    },
    raw: {
      fetchedAt: input.row.fetchedAt,
      holdReason: input.row.holdReason,
      id: input.row.rawDocumentId,
      ingestError: sanitizeNullable(input.row.ingestError),
      ingestStatus: input.row.ingestStatus,
      metadata: sanitizeMetadata(input.row.metadata),
      sanitizedSampleUri: input.row.sanitizedSampleUri,
      sourceId: input.row.sourceId,
      sourceType: input.row.sourceType,
      sourceUri: input.row.sourceUri,
    },
    sourceContract,
  };
}

function validateSourceContract(input: any): any {
  if (input.row.sourceType === 'web') {
    const canonicalUrl = readString(input.row.metadata?.canonicalUrl);
    const title = readString(input.row.metadata?.title);
    const bodyText = input.parsed?.bodyText ?? input.parsedFromRaw?.bodyText;
    return {
      canonicalUrlMatchesSourceId: canonicalUrl === input.row.sourceId,
      contentHashMatchesStorage: input.actualContentHash === input.row.contentHash,
      hasCanonicalUrl: Boolean(canonicalUrl),
      hasExtractedTitle: Boolean(title),
      parsedCanonicalUri: input.parsed?.canonicalUri ?? input.parsedFromRaw?.canonicalUri ?? null,
      parsedDocType: input.parsed?.docType ?? input.parsedFromRaw?.docType ?? null,
      parsedHasBodyText: typeof bodyText === 'string' && bodyText.trim().length > 0,
      sourceType: 'web',
    };
  }

  return {
    contentHashMatchesStorage: input.actualContentHash === input.row.contentHash,
    parsedDocType: input.parsed?.docType ?? input.parsedFromRaw?.docType ?? null,
    sourceType: input.row.sourceType,
  };
}

async function safeReadText(storage: any, uri: any): Promise<any> {
  try {
    return await storage.getText(uri);
  } catch {
    return undefined;
  }
}

async function safeReadParsed(storage: any, uri: any): Promise<any> {
  try {
    return validateParsedDocument(JSON.parse(await storage.getText(uri)));
  } catch {
    return null;
  }
}

function parseRawSafely(row: any, rawText: any): any {
  try {
    return validateParsedDocument(
      parseRawContent(
        {
          raw: {
            contentHash: row.contentHash,
            metadata: row.metadata ?? {},
            mimeType: row.mimeType,
            projectSlug: '',
            sourceId: row.sourceId,
            sourceType: row.sourceType,
            sourceUri: row.sourceUri,
            storageUri: row.storageUri,
          },
          sourceType: row.sourceType,
        },
        rawText,
      ),
    );
  } catch {
    return null;
  }
}

function summarize(documents: any): any {
  return {
    byIngestStatus: countBy(documents, (document: any): any => document.raw.ingestStatus),
    byQueueStatus: countBy(documents, (document: any): any => document.queue.status ?? '<none>'),
    failedContracts: documents.filter(
      (document: any): any => !isContractPassing(document.sourceContract),
    ).length,
    total: documents.length,
  };
}

function isContractPassing(contract: any): any {
  return Object.entries(contract).every(([, value]): any => typeof value !== 'boolean' || value);
}

function countBy(values: any, keyFn: any): any {
  const counts: any = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function lookupProject(sql: any, slug: any): Promise<any> {
  return singleJson(
    await sql`
      SELECT id::text AS id, slug
      FROM public.projects
      WHERE slug = ${slug}
    `,
  );
}

function sanitizeMetadata(metadata: any): any {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  const sanitized = { ...metadata };
  delete sanitized.body;
  delete sanitized.html;
  delete sanitized.text;
  return sanitized;
}

function sanitizeNullable(value: any): any {
  return typeof value === 'string' ? value.slice(0, 500) : value;
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

function parseArgs(argv: any): any {
  const options: any = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      options.source = readSourceType(readOptionValue(argv, ++index, arg));
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--format') {
      options.format = readFormat(readOptionValue(argv, ++index, arg));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readSourceType(value: string): string {
  if (!SOURCE_TYPES.includes(value)) {
    throw new Error(`Unsupported --source value: ${value}`);
  }
  return value;
}

function readFormat(value: string): string {
  if (value !== 'json') {
    throw new Error(`Unsupported --format value: ${value}`);
  }
  return value;
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function singleJson(rows: any): any {
  return rows[0];
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
