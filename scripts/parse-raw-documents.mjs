import postgres from 'postgres';
import {
  BUILT_IN_PARSER_ARTIFACT_HASH,
  defaultParserContract,
  parseRawDocuments,
} from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresRawParseRepository(sql, options.source);

  try {
    if (options.seedBuiltInParsers !== false) {
      await ensureBuiltInParserVersions({ projectSlug, sourceType: options.source, sql });
    }

    const result = await parseRawDocuments({
      limit: options.limit ?? 10,
      projectSlug,
      repository,
      storage,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresRawParseRepository {
  constructor(sql, sourceType) {
    this.sql = sql;
    this.sourceType = sourceType;
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

  async dequeueTargets(input) {
    return this.sql`
      WITH candidates AS (
        SELECT q.id AS queue_id
        FROM public.ingestion_queue q
        JOIN public.raw_documents rd ON rd.id = q.raw_document_id
        WHERE q.project_id = ${input.projectId}
          AND q.status IN ('pending', 'failed')
          AND rd.ingest_status IN ('fetched', 'failed')
          AND (${this.sourceType ?? null}::text IS NULL OR rd.source_type = ${this.sourceType ?? null})
        ORDER BY q.priority DESC, q.scheduled_at, q.created_at
        LIMIT ${input.limit}
        FOR UPDATE OF q SKIP LOCKED
      ),
      updated AS (
        UPDATE public.ingestion_queue q
        SET
          status = 'parsing',
          attempts = attempts + 1,
          last_error = null,
          hold_reason = null,
          sanitized_sample_uri = null
        FROM candidates c
        WHERE q.id = c.queue_id
        RETURNING
          q.id,
          q.data_source_id,
          q.project_id,
          q.raw_document_id
      )
      SELECT
        updated.data_source_id::text AS "dataSourceId",
        updated.id::text AS id,
        updated.project_id::text AS "projectId",
        jsonb_build_object(
          'contentHash', rd.content_hash,
          'id', rd.id::text,
          'metadata', rd.metadata,
          'mimeType', rd.mime_type,
          'projectId', rd.project_id::text,
          'sourceId', rd.source_id,
          'sourceType', rd.source_type,
          'sourceUri', rd.source_uri,
          'storageUri', rd.storage_uri
        ) AS "rawDocument"
      FROM updated
      JOIN public.raw_documents rd ON rd.id = updated.raw_document_id
      ORDER BY updated.id
    `;
  }

  async selectActiveParserVersion(input) {
    return singleJson(
      await this.sql`
        SELECT
          pv.artifact_hash AS "artifactHash",
          pv.artifact_uri AS "artifactUri",
          pv.contract,
          pv.id::text AS id,
          pp.id::text AS "parserProfileId",
          pv.schema_version AS "schemaVersion",
          pp.source_type AS "sourceType",
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

  async markParsed(input) {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE public.raw_documents
        SET
          parsed_uri = ${input.parsedUri},
          parsed_at = ${input.parsedAt},
          ingest_status = 'parsed',
          ingest_error = null,
          hold_reason = null,
          parser_profile_id = ${input.parserProfileId},
          parser_version_id = ${input.parserVersionId},
          parser_artifact_hash = ${input.parserArtifactHash},
          parsed_schema_version = ${input.schemaVersion}
        WHERE id = ${input.rawDocumentId}
      `;
      await transaction`
        UPDATE public.ingestion_queue
        SET
          status = 'parsed',
          last_error = null,
          hold_reason = null,
          parser_profile_id = ${input.parserProfileId},
          parser_version_id = ${input.parserVersionId}
        WHERE id = ${input.queueId}
      `;
    });
  }

  async markFailed(input) {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE public.raw_documents
        SET
          ingest_status = 'failed',
          ingest_error = ${input.lastError},
          hold_reason = null,
          parser_profile_id = ${input.parserProfileId ?? null},
          parser_version_id = ${input.parserVersionId ?? null},
          sanitized_sample_uri = ${input.sanitizedSampleUri ?? null}
        WHERE id = ${input.rawDocumentId}
      `;
      await transaction`
        UPDATE public.ingestion_queue
        SET
          status = 'failed',
          last_error = ${input.lastError},
          hold_reason = null,
          parser_profile_id = ${input.parserProfileId ?? null},
          parser_version_id = ${input.parserVersionId ?? null},
          sanitized_sample_uri = ${input.sanitizedSampleUri ?? null}
        WHERE id = ${input.queueId}
      `;
    });
  }

  async markHeld(input) {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE public.raw_documents
        SET
          ingest_status = 'held',
          ingest_error = ${input.lastError},
          hold_reason = ${input.holdReason},
          parser_profile_id = ${input.parserProfileId ?? null},
          parser_version_id = ${input.parserVersionId ?? null}
        WHERE id = ${input.rawDocumentId}
      `;
      await transaction`
        UPDATE public.ingestion_queue
        SET
          status = 'held',
          last_error = ${input.lastError},
          hold_reason = ${input.holdReason},
          parser_profile_id = ${input.parserProfileId ?? null},
          parser_version_id = ${input.parserVersionId ?? null}
        WHERE id = ${input.queueId}
      `;
    });
  }
}

async function ensureBuiltInParserVersions(input) {
  const sourceTypes = input.sourceType ? [input.sourceType] : SOURCE_TYPES;

  for (const sourceType of sourceTypes) {
    await input.sql`
      WITH project AS (
        SELECT id FROM public.projects WHERE slug = ${input.projectSlug}
      ),
      sources AS (
        SELECT id AS data_source_id, project_id, source_type
        FROM public.data_sources
        WHERE project_id = (SELECT id FROM project)
          AND source_type = ${sourceType}
          AND enabled = true
      ),
      profiles AS (
        INSERT INTO public.parser_profiles (
          project_id,
          data_source_id,
          source_type,
          name,
          metadata
        )
        SELECT
          sources.project_id,
          sources.data_source_id,
          sources.source_type,
          ${`Built-in ${sourceType} parser`},
          ${input.sql.json({ managedBy: 'scripts/parse-raw-documents.mjs' })}
        FROM sources
        ON CONFLICT (project_id, data_source_id, source_type, name)
        DO UPDATE SET metadata = EXCLUDED.metadata
        RETURNING id, source_type
      ),
      versions AS (
        INSERT INTO public.parser_versions (
          parser_profile_id,
          version,
          schema_version,
          artifact_hash,
          contract,
          status,
          approved_by_user_id,
          approved_at
        )
        SELECT
          profiles.id,
          'fixture-parser-v1',
          1,
          ${BUILT_IN_PARSER_ARTIFACT_HASH},
          ${input.sql.json(defaultParserContract(sourceType))},
          'approved',
          '00000000-0000-0000-0000-000000000001',
          now()
        FROM profiles
        ON CONFLICT (parser_profile_id, version)
        DO UPDATE SET
          artifact_hash = EXCLUDED.artifact_hash,
          contract = EXCLUDED.contract,
          status = 'approved',
          approved_by_user_id = EXCLUDED.approved_by_user_id,
          approved_at = COALESCE(public.parser_versions.approved_at, now())
        RETURNING id, parser_profile_id
      )
      UPDATE public.parser_profiles pp
      SET active_version_id = versions.id
      FROM versions
      WHERE pp.id = versions.parser_profile_id
    `;
    await input.sql`
      UPDATE public.parser_profiles pp
      SET active_version_id = pv.id
      FROM public.parser_versions pv, public.projects p
      WHERE pv.parser_profile_id = pp.id
        AND pv.version = 'fixture-parser-v1'
        AND pv.status = 'approved'
        AND p.id = pp.project_id
        AND p.slug = ${input.projectSlug}
        AND pp.source_type = ${sourceType}
    `;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv[++index], arg);
    } else if (arg === '--source') {
      options.source = readSourceType(argv[++index], arg);
    } else if (arg === '--limit') {
      options.limit = Number(readOptionValue(argv[++index], arg));
    } else if (arg === '--no-seed-built-in-parsers') {
      options.seedBuiltInParsers = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readOptionValue(value, optionName) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readSourceType(value, optionName) {
  const sourceType = readOptionValue(value, optionName);
  if (!SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`Unsupported ${optionName} value: ${sourceType}`);
  }
  return sourceType;
}

function createLocalObjectStorageFromEnv(env = process.env) {
  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required.');
  }
  return new LocalFsObjectStorage(root);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function singleJson(rows) {
  return rows[0];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
