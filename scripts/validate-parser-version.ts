import postgres from 'postgres';
import {
  parseRawContent,
  validateParsedDocument,
  validateParserContract,
} from '../packages/ingestion/dist/index.js';
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

    const rows = await readRawDocuments({
      heldOnly: options.held ?? false,
      limit: options.limit ?? 10,
      projectId: project.id,
      sourceType,
      sql,
    });
    const results = [];

    for (const row of rows) {
      const parserVersion = await selectActiveParserVersion({
        dataSourceId: row.dataSourceId,
        projectId: project.id,
        sourceType,
        sql,
      });
      results.push(await validateRawDocument({ parserVersion, project, row, storage }));
    }

    const output = {
      dryRun: options.dryRun ?? false,
      heldOnly: options.held ?? false,
      project: { id: project.id, slug: project.slug },
      results,
      source: sourceType,
      summary: {
        failed: results.filter((result: any): any => !result.ok).length,
        total: results.length,
        valid: results.filter((result: any): any => result.ok).length,
      },
    };

    console.log(JSON.stringify(output, null, 2));
    if (output.summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

async function validateRawDocument(input: any): Promise<any> {
  if (!input.parserVersion) {
    return {
      error: 'No approved active parser version was found.',
      ok: false,
      rawDocumentId: input.row.rawDocumentId,
      sourceId: input.row.sourceId,
    };
  }

  let rawText: string;
  try {
    rawText = await input.storage.getText(input.row.storageUri);
  } catch (error) {
    return {
      error: sanitizeError(error),
      ok: false,
      parserVersionId: input.parserVersion.id,
      rawDocumentId: input.row.rawDocumentId,
      sourceId: input.row.sourceId,
    };
  }

  const contractResult = validateParserContract(rawText, input.parserVersion.contract);
  if (!contractResult.ok) {
    return {
      error: contractResult.error,
      ok: false,
      parserVersionId: input.parserVersion.id,
      rawDocumentId: input.row.rawDocumentId,
      sourceId: input.row.sourceId,
    };
  }

  try {
    const parsed = validateParsedDocument(
      parseRawContent(
        {
          raw: {
            contentHash: input.row.contentHash,
            metadata: input.row.metadata ?? {},
            mimeType: input.row.mimeType,
            projectSlug: input.project.slug,
            sourceId: input.row.sourceId,
            sourceType: input.row.sourceType,
            sourceUri: input.row.sourceUri,
            storageUri: input.row.storageUri,
          },
          sourceType: input.row.sourceType,
        },
        rawText,
      ),
    );

    return {
      docType: parsed.docType,
      ok: true,
      parserVersionId: input.parserVersion.id,
      rawDocumentId: input.row.rawDocumentId,
      sourceId: input.row.sourceId,
      title: parsed.title,
    };
  } catch (error) {
    return {
      error: sanitizeError(error),
      ok: false,
      parserVersionId: input.parserVersion.id,
      rawDocumentId: input.row.rawDocumentId,
      sourceId: input.row.sourceId,
    };
  }
}

async function readRawDocuments(input: any): Promise<any> {
  return input.sql`
    SELECT
      q.data_source_id::text AS "dataSourceId",
      rd.content_hash AS "contentHash",
      rd.id::text AS "rawDocumentId",
      rd.metadata,
      rd.mime_type AS "mimeType",
      rd.source_id AS "sourceId",
      rd.source_type AS "sourceType",
      rd.source_uri AS "sourceUri",
      rd.storage_uri AS "storageUri"
    FROM public.raw_documents rd
    JOIN public.ingestion_queue q ON q.raw_document_id = rd.id
    WHERE rd.project_id = ${input.projectId}
      AND rd.source_type = ${input.sourceType}
      AND (${input.heldOnly} = false OR rd.ingest_status = 'held' OR q.status = 'held')
    ORDER BY rd.updated_at DESC, rd.fetched_at DESC
    LIMIT ${input.limit}
  `;
}

async function selectActiveParserVersion(input: any): Promise<any> {
  return singleJson(
    await input.sql`
      SELECT
        pv.contract,
        pv.id::text AS id,
        pp.id::text AS "parserProfileId",
        pv.schema_version AS "schemaVersion",
        pv.status,
        pv.version
      FROM public.parser_profiles pp
      JOIN public.parser_versions pv ON pv.id = pp.active_version_id
      WHERE pp.project_id = ${input.projectId}
        AND pp.source_type = ${input.sourceType}
        AND pv.status = 'approved'
        AND (pp.data_source_id = ${input.dataSourceId} OR pp.data_source_id IS NULL)
      ORDER BY pp.data_source_id IS NULL, pp.created_at DESC, pp.id DESC
      LIMIT 1
    `,
  );
}

async function lookupProject(sql: postgres.Sql, slug: string): Promise<any> {
  return singleJson(
    await sql`
      SELECT id::text AS id, slug
      FROM public.projects
      WHERE slug = ${slug}
    `,
  );
}

function parseArgs(argv: string[]): {
  project?: string;
  source?: string;
  limit?: number;
  held?: boolean;
  dryRun?: boolean;
} {
  const options: {
    project?: string;
    source?: string;
    limit?: number;
    held?: boolean;
    dryRun?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      options.source = readSourceType(readOptionValue(argv, ++index, arg));
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--held') {
      options.held = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
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

function readSourceType(value: string): string {
  if (!SOURCE_TYPES.includes(value)) {
    throw new Error(`Unsupported --source value: ${value}`);
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

function sanitizeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'redacted@example.test')
    .replace(/https?:\/\/[^\s"'<>]+/gi, 'https://example.test/redacted')
    .slice(0, 500);
}

function singleJson<T>(rows: T[]): T | undefined {
  return rows[0];
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
