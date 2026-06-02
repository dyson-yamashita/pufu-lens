import postgres from 'postgres';
import { storeGraphRelations } from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresGraphRelationsRepository(sql, storage, options.source);

  try {
    const result = await storeGraphRelations({
      limit: options.limit ?? 10,
      projectSlug,
      repository,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresGraphRelationsRepository {
  private sql: postgres.Sql;
  private storage: LocalFsObjectStorage;
  private sourceType: string | undefined;
  private graphName: string | undefined;
  constructor(sql: postgres.Sql, storage: LocalFsObjectStorage, sourceType: string | undefined) {
    this.sql = sql;
    this.storage = storage;
    this.sourceType = sourceType;
    this.graphName = undefined;
  }

  async lookupProjectBySlug(slug: string): Promise<any> {
    const project = singleJson(
      await this.sql`
        SELECT graph_name AS "graphName", id::text AS id, slug
        FROM public.projects
        WHERE slug = ${slug}
      `,
    );
    if (project) {
      this.graphName = validateGraphName(project.graphName);
      await ensureAgeSession(this.sql);
      await ensureGraph(this.sql, this.graphName);
    }
    return project;
  }

  async readGraphTargets(input: any): Promise<any> {
    const rows = await this.sql`
      SELECT
        d.doc_type AS "docType",
        d.graph_node_id AS "graphNodeId",
        d.id::text AS "documentId",
        d.raw_document_id::text AS "documentRawDocumentId",
        rd.content_hash AS "rawContentHash",
        rd.id::text AS "rawDocumentId",
        rd.parsed_uri AS "parsedUri"
      FROM public.documents d
      JOIN public.raw_documents rd ON rd.id = d.raw_document_id
      WHERE d.project_id = ${input.projectId}
        AND rd.project_id = ${input.projectId}
        AND rd.parsed_uri IS NOT NULL
        AND rd.ingest_status IN ('parsed', 'indexed')
        AND (${this.sourceType ?? null}::text IS NULL OR rd.source_type = ${this.sourceType ?? null})
      ORDER BY rd.parsed_at NULLS LAST, rd.fetched_at, rd.id
      LIMIT ${input.limit}
    `;

    return Promise.all(
      rows.map(
        async (row: any): Promise<any> => ({
          document: {
            docType: row.docType,
            graphNodeId: row.graphNodeId,
            id: row.documentId,
            rawDocumentId: row.documentRawDocumentId,
          },
          parsed: await this.storage.getText(row.parsedUri),
          rawContentHash: row.rawContentHash,
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
          a.id::text AS id
        FROM public.actor_aliases aa
        JOIN public.actors a ON a.id = aa.actor_id
        WHERE aa.project_id = ${input.projectId}
          AND aa.alias_type = ${input.aliasType}
          AND aa.alias_value = ${input.aliasValue}
        LIMIT 1
      `,
    );
  }

  async findActorByGraphNodeId(input: any): Promise<any> {
    return singleJson(
      await this.sql`
        SELECT
          display_name AS "displayName",
          graph_node_id AS "graphNodeId",
          id::text AS id
        FROM public.actors
        WHERE project_id = ${input.projectId}
          AND graph_node_id = ${input.graphNodeId}
        LIMIT 1
      `,
    );
  }

  async findSameAsDocuments(input: any): Promise<any> {
    return this.sql`
      SELECT
        d.doc_type AS "docType",
        d.graph_node_id AS "graphNodeId",
        d.id::text AS id,
        d.raw_document_id::text AS "rawDocumentId"
      FROM public.documents d
      JOIN public.raw_documents rd ON rd.id = d.raw_document_id
      WHERE d.project_id = ${input.projectId}
        AND rd.project_id = ${input.projectId}
        AND rd.id <> ${input.rawDocumentId}
        AND rd.source_type <> ${input.sourceType}
        AND rd.content_hash = ${input.rawContentHash}
    `;
  }

  async upsertGraphNode(input: any): Promise<any> {
    const graphName = requiredGraphName(this.graphName);
    const label = validateLabel(input.labels[0] ?? 'Document');
    const properties = {
      ...input.properties,
      graphLabels: input.labels,
      graphNodeId: input.graphNodeId,
    };
    const setClause = parameterizedSetClause('n', properties, 'node');
    await executeCypher(
      this.sql,
      graphName,
      `MERGE (n:${label} {graphNodeId: $graphNodeId}) ${setClause.cypher} RETURN n`,
      { graphNodeId: input.graphNodeId, ...setClause.params },
    );
  }

  async upsertGraphEdge(input: any): Promise<any> {
    const graphName = requiredGraphName(this.graphName);
    const edgeType = validateLabel(input.type);
    const setClause = parameterizedSetClause('r', input.properties, 'edge');
    await executeCypher(
      this.sql,
      graphName,
      [
        'MATCH (from {graphNodeId: $fromGraphNodeId})',
        'MATCH (to {graphNodeId: $toGraphNodeId})',
        `MERGE (from)-[r:${edgeType}]->(to)`,
        setClause.cypher,
        'RETURN r',
      ].join(' '),
      {
        fromGraphNodeId: input.fromGraphNodeId,
        ...setClause.params,
        toGraphNodeId: input.toGraphNodeId,
      },
    );
  }

  async replaceEmailQuotes(input: any): Promise<any> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<any> => {
      await transaction`
        DELETE FROM public.email_quotes
        WHERE project_id = ${input.projectId}
          AND document_id = ${input.documentId}
      `;
      const insertedByIndex = new Map<any, any>();
      const sortedQuotes = [...input.quotes].sort(
        (a: any, b: any): any => a.quoteIndex - b.quoteIndex,
      );
      for (const quote of sortedQuotes) {
        const inserted = singleJson(
          await transaction`
            INSERT INTO public.email_quotes (
              project_id,
              document_id,
              quote_index,
              quoted_message_id,
              prev_quote_id,
              sender_alias,
              sender_actor_id,
              sent_at,
              body,
              metadata
            )
            VALUES (
              ${input.projectId},
              ${input.documentId},
              ${quote.quoteIndex},
              ${quote.quotedMessageId},
              ${quote.prevQuoteIndex === undefined ? null : (insertedByIndex.get(quote.prevQuoteIndex) ?? null)},
              ${quote.senderAlias},
              ${quote.senderActorId ?? null},
              ${quote.sentAt},
              ${quote.bodyText},
              ${transaction.json({})}
            )
            RETURNING id::text AS id, quote_index AS "quoteIndex"
          `,
        );
        insertedByIndex.set(inserted.quoteIndex, inserted.id);
      }
    });
  }

  async markIndexed(input: any): Promise<any> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<any> => {
      await transaction`
        UPDATE public.raw_documents
        SET ingest_status = 'indexed', indexed_at = now(), ingest_error = null
        WHERE project_id = ${input.projectId}
          AND id = ${input.rawDocumentId}
      `;
      await transaction`
        UPDATE public.ingestion_queue
        SET status = 'indexed', last_error = null
        WHERE project_id = ${input.projectId}
          AND raw_document_id = ${input.rawDocumentId}
      `;
    });
  }

  async markFailed(input: any): Promise<any> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<any> => {
      await transaction`
        UPDATE public.raw_documents
        SET ingest_status = 'failed', ingest_error = ${input.errorMessage}
        WHERE project_id = ${input.projectId}
          AND id = ${input.rawDocumentId}
      `;
      await transaction`
        UPDATE public.ingestion_queue
        SET status = 'failed', last_error = ${input.errorMessage}
        WHERE project_id = ${input.projectId}
          AND raw_document_id = ${input.rawDocumentId}
      `;
    });
  }
}

async function ensureAgeSession(sql: postgres.Sql): Promise<void> {
  await sql.unsafe("LOAD 'age'");
  await sql.unsafe('SET search_path = ag_catalog, "$user", public');
}

async function ensureGraph(sql: postgres.Sql, graphName: string): Promise<void> {
  await sql.unsafe(`SELECT create_graph(${sqlString(graphName)}) WHERE NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(graphName)}
  )`);
}

async function executeCypher(
  sql: postgres.Sql,
  graphName: string,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  await sql.unsafe(
    `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(cypher)}, $1::agtype) AS (value agtype)`,
    [JSON.stringify(params)],
  );
}

function parseArgs(argv: string[]): any {
  const options: any = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      options.source = readSourceType(readOptionValue(argv, ++index, arg));
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
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

function createLocalObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalFsObjectStorage {
  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required.');
  }
  return new LocalFsObjectStorage(root);
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

function requiredGraphName(value: string | undefined): string {
  if (!value) {
    throw new Error('Graph name is not initialized.');
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

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateGraphName(graphName: string): string {
  if (!/^graph_[a-z0-9_]+$/.test(graphName) || graphName.length > 63) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
  return graphName;
}

function validateLabel(label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) {
    throw new Error(`Invalid graph label or edge type: ${label}`);
  }
  return label;
}

function parameterizedSetClause(variableName: any, properties: any, paramPrefix: any): any {
  const assignments = [];
  const params: any = {};
  let index = 0;
  for (const [propertyName, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    const paramName = `${paramPrefix}${index}`;
    assignments.push(`${variableName}.${validatePropertyName(propertyName)} = $${paramName}`);
    params[paramName] = graphPropertyValue(value);
    index += 1;
  }
  return {
    cypher: assignments.length === 0 ? '' : `SET ${assignments.join(', ')}`,
    params,
  };
}

function graphPropertyValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function dollarQuote(value: string): string {
  return `$pufu_static$${value}$pufu_static$`;
}

function validatePropertyName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid graph property name: ${name}`);
  }
  return name;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
