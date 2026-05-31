import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFixtureSource } from '../packages/ingestion/dist/collection-pipeline.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const databaseUrl = requiredEnv('DATABASE_URL');
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PsqlCollectionRepository(databaseUrl);

  await ensureFixtureDataSources({
    databaseUrl,
    projectSlug,
    sourceType: options.source,
  });

  const result = await collectFixtureSource({
    projectSlug,
    repoRoot,
    repository,
    sourceType: options.source,
    storage,
  });

  console.log(JSON.stringify(result, null, 2));
}

class PsqlCollectionRepository {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
  }

  async lookupProjectBySlug(slug) {
    return singleJson(
      await this.queryJsonLines(`
        SELECT json_build_object('id', id, 'slug', slug)
        FROM public.projects
        WHERE slug = ${sqlString(slug)}
      `),
    );
  }

  async findDataSources(projectId, sourceType) {
    const sourceFilter = sourceType ? `AND source_type = ${sqlString(sourceType)}` : '';
    return this.queryJsonLines(`
      SELECT json_build_object(
        'config', config,
        'enabled', enabled,
        'id', id,
        'ingestWindow', ingest_window,
        'projectId', project_id,
        'sourceType', source_type
      )
      FROM public.data_sources
      WHERE project_id = ${sqlString(projectId)}
        AND enabled = true
        ${sourceFilter}
      ORDER BY source_type, name
    `);
  }

  async lookupRawDocument(input) {
    return singleJson(
      await this.queryJsonLines(`
        SELECT json_build_object(
          'id', id,
          'ingestStatus', ingest_status,
          'sourceId', source_id,
          'sourceType', source_type
        )
        FROM public.raw_documents
        WHERE project_id = ${sqlString(input.projectId)}
          AND source_type = ${sqlString(input.sourceType)}
          AND source_id = ${sqlString(input.sourceId)}
      `),
    );
  }

  async findSameHashCandidates(input) {
    return this.queryJsonLines(`
      SELECT json_build_object('id', id, 'sourceId', source_id, 'sourceType', source_type)
      FROM public.raw_documents
      WHERE project_id = ${sqlString(input.projectId)}
        AND content_hash = ${sqlString(input.contentHash)}
        AND source_type <> ${sqlString(input.sourceType)}
      ORDER BY created_at
    `);
  }

  async upsertRawDocument(input) {
    const rawDocument = singleJson(
      await this.queryJsonLines(`
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
          ${sqlString(input.projectId)},
          ${sqlString(input.sourceType)},
          ${sqlString(input.sourceId)},
          ${sqlString(input.sourceUri)},
          ${sqlString(input.storageUri)},
          ${sqlString(input.mimeType)},
          ${input.byteSize},
          ${sqlString(input.contentHash)},
          'fetched',
          ${sqlJson(input.metadata)}
        )
        ON CONFLICT (project_id, source_type, source_id)
        DO UPDATE SET
          source_uri = EXCLUDED.source_uri,
          storage_uri = EXCLUDED.storage_uri,
          mime_type = EXCLUDED.mime_type,
          byte_size = EXCLUDED.byte_size,
          content_hash = EXCLUDED.content_hash,
          metadata = EXCLUDED.metadata
        RETURNING json_build_object(
          'id', id,
          'ingestStatus', ingest_status,
          'sourceId', source_id,
          'sourceType', source_type
        )
      `),
    );

    if (!rawDocument) {
      throw new Error(`Failed to upsert raw document: ${input.sourceType}:${input.sourceId}`);
    }

    return rawDocument;
  }

  async linkDataSource(input) {
    await this.exec(`
      INSERT INTO public.raw_document_data_sources (
        raw_document_id,
        data_source_id,
        project_id,
        match_reason,
        metadata
      )
      VALUES (
        ${sqlString(input.rawDocumentId)},
        ${sqlString(input.dataSourceId)},
        ${sqlString(input.projectId)},
        ${sqlString(input.matchReason)},
        ${sqlJson(input.metadata)}
      )
      ON CONFLICT (raw_document_id, data_source_id)
      DO UPDATE SET
        last_seen_at = now(),
        match_reason = EXCLUDED.match_reason,
        metadata = EXCLUDED.metadata
    `);
  }

  async queueCandidate(input) {
    await this.exec(`
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
        ${sqlString(input.projectId)},
        ${sqlString(input.dataSourceId)},
        ${sqlString(input.rawDocumentId)},
        ${sqlString(input.targetId)},
        ${sqlString(input.targetUri)},
        'pending',
        'fixture-collection'
      )
      ON CONFLICT (project_id, raw_document_id)
      DO UPDATE SET
        data_source_id = EXCLUDED.data_source_id,
        target_id = EXCLUDED.target_id,
        target_uri = EXCLUDED.target_uri,
        reason = EXCLUDED.reason
    `);
  }

  async markDataSourceChecked(dataSourceId) {
    await this.exec(`
      UPDATE public.data_sources
      SET last_checked_at = now()
      WHERE id = ${sqlString(dataSourceId)}
    `);
  }

  async exec(sql) {
    await runPsql(this.databaseUrl, sql, { captureStdout: false });
  }

  async queryJsonLines(sql) {
    const output = await runPsql(this.databaseUrl, sql, { captureStdout: true });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

async function ensureFixtureDataSources(input) {
  const sourceTypes = input.sourceType ? [input.sourceType] : SOURCE_TYPES;
  const values = sourceTypes
    .map(
      (sourceType) => `(
        ${sqlString(sourceType)},
        ${sqlString(`Fixture ${sourceType}`)},
        ${sqlJson({ source: 'fixtures/ingestion' })},
        ${sqlJson({})}
      )`,
    )
    .join(',\n');

  await runPsql(
    input.databaseUrl,
    `
      WITH project AS (
        SELECT id FROM public.projects WHERE slug = ${sqlString(input.projectSlug)}
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
        source_rows.source_type,
        source_rows.name,
        source_rows.config,
        source_rows.ingest_window
      FROM project
      CROSS JOIN (VALUES ${values}) AS source_rows(
        source_type,
        name,
        config,
        ingest_window
      )
      ON CONFLICT (project_id, source_type, name)
      DO UPDATE SET
        enabled = true,
        config = EXCLUDED.config,
        ingest_window = EXCLUDED.ingest_window
    `,
    { captureStdout: false },
  );
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

async function runPsql(databaseUrl, sql, options) {
  return await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...databaseUrlToPsqlEnv(databaseUrl),
    };
    delete env.DATABASE_URL;

    const stdout = [];
    const child = spawn(
      'psql',
      ['--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'],
      {
        env,
        stdio: ['pipe', options.captureStdout ? 'pipe' : 'inherit', 'inherit'],
      },
    );

    if (options.captureStdout && child.stdout) {
      child.stdout.on('data', (chunk) => stdout.push(chunk));
    }

    child.stdin.on('error', () => {});
    child.stdin.end(sql);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }

      reject(new Error(`psql exited with code ${code}`));
    });
  });
}

function databaseUrlToPsqlEnv(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  }

  const database = url.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL must include a database name.');
  }

  const env = {
    PGDATABASE: decodeURIComponent(database),
  };

  if (url.hostname) {
    env.PGHOST = url.hostname;
  }

  if (url.port) {
    env.PGPORT = url.port;
  }

  if (url.username) {
    env.PGUSER = decodeURIComponent(url.username);
  }

  if (url.password) {
    env.PGPASSWORD = decodeURIComponent(url.password);
  }

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) {
    env.PGSSLMODE = sslMode;
  }

  return env;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function sqlString(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
