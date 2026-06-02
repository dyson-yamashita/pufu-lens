import postgres from 'postgres';
import { resolveActors } from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresActorResolutionRepository(sql, storage, options.source);

  try {
    const result = await resolveActors({
      limit: options.limit ?? 10,
      projectSlug,
      repository,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresActorResolutionRepository {
  private sql: postgres.Sql;
  private storage: LocalFsObjectStorage;
  private sourceType: string | undefined;
  constructor(sql: postgres.Sql, storage: LocalFsObjectStorage, sourceType: string | undefined) {
    this.sql = sql;
    this.storage = storage;
    this.sourceType = sourceType;
  }

  async lookupProjectBySlug(slug: string): Promise<any> {
    return singleJson(
      await this.sql`
        SELECT id::text AS id, slug
        FROM public.projects
        WHERE slug = ${slug}
      `,
    );
  }

  async readParsedDocuments(input: any): Promise<any> {
    const rows = await this.sql`
      SELECT
        id::text AS "rawDocumentId",
        parsed_uri AS "parsedUri"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND ingest_status = 'parsed'
        AND parsed_uri IS NOT NULL
        AND (${this.sourceType ?? null}::text IS NULL OR source_type = ${this.sourceType ?? null})
      ORDER BY parsed_at NULLS LAST, fetched_at, id
      LIMIT ${input.limit}
    `;

    return Promise.all(
      rows.map(
        async (row: any): Promise<any> => ({
          parsed: await this.storage.getText(row.parsedUri),
          parsedUri: row.parsedUri,
          rawDocumentId: row.rawDocumentId,
        }),
      ),
    );
  }

  async findActorByAlias(input: any): Promise<any> {
    return singleJson(
      await this.sql`
        SELECT
          a.display_name AS "displayName",
          a.graph_node_id AS "graphNodeId",
          a.id::text AS id,
          a.primary_email AS "primaryEmail",
          a.primary_login AS "primaryLogin",
          a.project_id::text AS "projectId"
        FROM public.actor_aliases aa
        JOIN public.actors a ON a.id = aa.actor_id
        WHERE aa.project_id = ${input.projectId}
          AND aa.alias_type = ${input.aliasType}
          AND aa.alias_value = ${input.aliasValue}
        LIMIT 1
      `,
    );
  }

  async createActor(input: any): Promise<any> {
    const actor = singleJson(
      await this.sql`
        INSERT INTO public.actors (
          project_id,
          actor_type,
          display_name,
          primary_email,
          primary_login,
          metadata,
          graph_node_id
        )
        VALUES (
          ${input.projectId},
          ${input.actorType},
          ${input.displayName},
          ${input.primaryEmail ?? null},
          ${input.primaryLogin ?? null},
          ${this.sql.json(input.metadata)},
          ${input.graphNodeId}
        )
        ON CONFLICT (project_id, graph_node_id)
        DO UPDATE SET
          display_name = public.actors.display_name,
          primary_email = COALESCE(public.actors.primary_email, EXCLUDED.primary_email),
          primary_login = COALESCE(public.actors.primary_login, EXCLUDED.primary_login),
          metadata = COALESCE(public.actors.metadata, '{}'::jsonb) || EXCLUDED.metadata
        RETURNING
          display_name AS "displayName",
          graph_node_id AS "graphNodeId",
          id::text AS id,
          primary_email AS "primaryEmail",
          primary_login AS "primaryLogin",
          project_id::text AS "projectId"
      `,
    );

    if (!actor) {
      throw new Error(`Failed to create actor: ${input.graphNodeId}`);
    }
    return actor;
  }

  async upsertActorAlias(input: any): Promise<any> {
    const alias = singleJson(
      await this.sql`
        INSERT INTO public.actor_aliases (
          project_id,
          actor_id,
          alias_type,
          alias_value,
          confidence,
          source
        )
        VALUES (
          ${input.projectId},
          ${input.actorId},
          ${input.aliasType},
          ${input.aliasValue},
          ${input.confidence},
          ${input.source}
        )
        ON CONFLICT (project_id, alias_type, alias_value)
        DO UPDATE SET
          actor_id = EXCLUDED.actor_id,
          confidence = GREATEST(public.actor_aliases.confidence, EXCLUDED.confidence),
          source = (
            SELECT string_agg(DISTINCT val, ',' ORDER BY val)
            FROM unnest(
              string_to_array(
                COALESCE(public.actor_aliases.source, '') || ',' || COALESCE(EXCLUDED.source, ''),
                ','
              )
            ) AS val
            WHERE val <> ''
          )
        RETURNING
          actor_id::text AS "actorId",
          alias_type AS "aliasType",
          alias_value AS "aliasValue",
          confidence,
          project_id::text AS "projectId",
          source
      `,
    );

    if (!alias) {
      throw new Error(`Failed to upsert actor alias: ${input.aliasType}:${input.aliasValue}`);
    }
    return alias;
  }
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

function parseArgs(argv: string[]): {
  project?: string;
  source?: string;
  limit?: number;
} {
  const options: {
    project?: string;
    source?: string;
    limit?: number;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      options.source = readSourceType(readOptionValue(argv, ++index, arg));
    } else if (arg === '--limit') {
      const value = readOptionValue(argv, ++index, arg);
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`Invalid --limit value: ${value}`);
      }
      options.limit = limit;
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

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
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

function singleJson(rows: any): any {
  return rows[0];
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
