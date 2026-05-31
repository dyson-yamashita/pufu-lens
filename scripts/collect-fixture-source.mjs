import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { collectFixtureSource } from '../packages/ingestion/dist/collection-pipeline.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresCollectionRepository(sql);

  try {
    await ensureFixtureDataSources({
      projectSlug,
      sourceType: options.source,
      sql,
    });

    const result = await collectFixtureSource({
      projectSlug,
      repoRoot,
      repository,
      sourceType: options.source,
      storage,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresCollectionRepository {
  constructor(sql) {
    this.sql = sql;
  }

  async lookupProjectBySlug(slug) {
    return singleJson(
      await this.sql`
        SELECT id::text AS id, slug
        FROM public.projects
        WHERE slug = ${slug}
      `,
    );
  }

  async findDataSources(projectId, sourceType) {
    if (sourceType) {
      return this.sql`
        SELECT
          config,
          enabled,
          id::text AS id,
          ingest_window AS "ingestWindow",
          project_id::text AS "projectId",
          source_type AS "sourceType"
        FROM public.data_sources
        WHERE project_id = ${projectId}
          AND enabled = true
          AND source_type = ${sourceType}
        ORDER BY source_type, name
      `;
    }

    return this.sql`
      SELECT
        config,
        enabled,
        id::text AS id,
        ingest_window AS "ingestWindow",
        project_id::text AS "projectId",
        source_type AS "sourceType"
      FROM public.data_sources
      WHERE project_id = ${projectId}
        AND enabled = true
      ORDER BY source_type, name
    `;
  }

  async lookupRawDocument(input) {
    return singleJson(
      await this.sql`
        SELECT
          id::text AS id,
          ingest_status AS "ingestStatus",
          source_id AS "sourceId",
          source_type AS "sourceType"
        FROM public.raw_documents
        WHERE project_id = ${input.projectId}
          AND source_type = ${input.sourceType}
          AND source_id = ${input.sourceId}
      `,
    );
  }

  async findSameHashCandidates(input) {
    return this.sql`
      SELECT id::text AS id, source_id AS "sourceId", source_type AS "sourceType"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND content_hash = ${input.contentHash}
      ORDER BY created_at
    `;
  }

  async upsertRawDocument(input) {
    const rawDocument = singleJson(
      await this.sql`
        INSERT INTO public.raw_documents (
          project_id,
          source_type,
          source_id,
          source_uri,
          storage_uri,
          mime_type,
          byte_size,
          content_hash,
          ingest_status,
          metadata
        )
        VALUES (
          ${input.projectId},
          ${input.sourceType},
          ${input.sourceId},
          ${input.sourceUri},
          ${input.storageUri},
          ${input.mimeType},
          ${input.byteSize},
          ${input.contentHash},
          'fetched',
          ${this.sql.json(input.metadata)}
        )
        ON CONFLICT (project_id, source_type, source_id)
        DO UPDATE SET
          source_uri = EXCLUDED.source_uri,
          storage_uri = EXCLUDED.storage_uri,
          mime_type = EXCLUDED.mime_type,
          byte_size = EXCLUDED.byte_size,
          content_hash = EXCLUDED.content_hash,
          metadata = EXCLUDED.metadata
        RETURNING
          id::text AS id,
          ingest_status AS "ingestStatus",
          source_id AS "sourceId",
          source_type AS "sourceType"
      `,
    );

    if (!rawDocument) {
      throw new Error(`Failed to upsert raw document: ${input.sourceType}:${input.sourceId}`);
    }

    return rawDocument;
  }

  async linkDataSource(input) {
    await this.sql`
      INSERT INTO public.raw_document_data_sources (
        raw_document_id,
        data_source_id,
        project_id,
        match_reason,
        metadata
      )
      VALUES (
        ${input.rawDocumentId},
        ${input.dataSourceId},
        ${input.projectId},
        ${input.matchReason},
        ${this.sql.json(input.metadata)}
      )
      ON CONFLICT (raw_document_id, data_source_id)
      DO UPDATE SET
        last_seen_at = now(),
        match_reason = EXCLUDED.match_reason,
        metadata = EXCLUDED.metadata
    `;
  }

  async queueCandidate(input) {
    await this.sql`
      INSERT INTO public.ingestion_queue (
        project_id,
        data_source_id,
        raw_document_id,
        target_id,
        target_uri,
        status,
        reason
      )
      VALUES (
        ${input.projectId},
        ${input.dataSourceId},
        ${input.rawDocumentId},
        ${input.targetId},
        ${input.targetUri},
        'pending',
        'fixture-collection'
      )
      ON CONFLICT (project_id, raw_document_id)
      DO UPDATE SET
        data_source_id = EXCLUDED.data_source_id,
        target_id = EXCLUDED.target_id,
        target_uri = EXCLUDED.target_uri,
        reason = EXCLUDED.reason
    `;
  }

  async markDataSourceChecked(dataSourceId) {
    await this.sql`
      UPDATE public.data_sources
      SET last_checked_at = now()
      WHERE id = ${dataSourceId}
    `;
  }
}

async function ensureFixtureDataSources(input) {
  const sourceTypes = input.sourceType ? [input.sourceType] : SOURCE_TYPES;

  for (const sourceType of sourceTypes) {
    await input.sql`
      WITH project AS (
        SELECT id FROM public.projects WHERE slug = ${input.projectSlug}
      )
      INSERT INTO public.data_sources (
        project_id,
        owner_user_id,
        source_type,
        name,
        config,
        ingest_window
      )
      SELECT
        project.id,
        '00000000-0000-0000-0000-000000000001',
        ${sourceType},
        ${`Fixture ${sourceType}`},
        ${input.sql.json({ source: 'fixtures/ingestion' })},
        ${input.sql.json({})}
      FROM project
      ON CONFLICT (project_id, source_type, name)
      DO UPDATE SET
        enabled = true,
        config = EXCLUDED.config,
        ingest_window = EXCLUDED.ingest_window
    `;
  }
}

function createLocalObjectStorageFromEnv(env = process.env) {
  const driver = env.STORAGE_DRIVER ?? env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver !== 'local') {
    throw new Error(`Unsupported object storage driver for fixture collection CLI: ${driver}`);
  }

  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required for local object storage.');
  }

  return new LocalFsObjectStorage(root);
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project') {
      index += 1;
      options.project = readOptionValue(args, index, arg);
      continue;
    }

    if (arg === '--source') {
      index += 1;
      const sourceType = readOptionValue(args, index, arg);
      if (!SOURCE_TYPES.includes(sourceType)) {
        throw new Error(`Unsupported --source value: ${sourceType}`);
      }
      options.source = sourceType;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function requiredOption(value, optionName) {
  if (!value) {
    throw new Error(`${optionName} is required.`);
  }

  return value;
}

function singleJson(rows) {
  return rows[0];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
