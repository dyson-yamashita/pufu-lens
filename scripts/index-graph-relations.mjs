import postgres from 'postgres';
import { indexGraphRelations } from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresGraphRelationRepository(sql, storage);

  try {
    await setupAgeConnection(sql);
    const result = await indexGraphRelations({
      limit: options.limit ?? 10,
      projectSlug,
      repository,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresGraphRelationRepository {
  constructor(sql, storage) {
    this.sql = sql;
    this.storage = storage;
  }

  async lookupProjectBySlug(slug) {
    return singleJson(
      await this.sql`
        SELECT id::text AS id, slug, graph_name AS "graphName"
        FROM public.projects
        WHERE slug = ${slug}
      `,
    );
  }

  async listDocumentsForGraph(input) {
    const rows = await this.sql`
      SELECT
        d.canonical_uri AS "canonicalUri",
        d.doc_type AS "docType",
        d.id::text AS "documentId",
        d.graph_node_id AS "graphNodeId",
        d.occurred_at::text AS "occurredAt",
        rd.parsed_uri AS "parsedUri",
        d.raw_document_id::text AS "rawDocumentId",
        d.title
      FROM public.documents d
      JOIN public.raw_documents rd ON rd.id = d.raw_document_id
      WHERE d.project_id = ${input.projectId}
        AND rd.project_id = ${input.projectId}
        AND rd.ingest_status IN ('parsed', 'indexed')
        AND rd.parsed_uri IS NOT NULL
      ORDER BY d.occurred_at NULLS LAST, d.created_at, d.id
      LIMIT ${input.limit}
    `;

    return Promise.all(
      rows.map(async (row) => ({
        canonicalUri: row.canonicalUri,
        docType: row.docType,
        documentId: row.documentId,
        graphNodeId: row.graphNodeId,
        occurredAt: row.occurredAt,
        parsed: await this.storage.getText(row.parsedUri),
        rawDocumentId: row.rawDocumentId,
        title: row.title,
      })),
    );
  }

  async findActorByAlias(input) {
    return singleJson(
      await this.sql`
        SELECT
          a.display_name AS "displayName",
          a.graph_node_id AS "graphNodeId",
          a.id::text AS id,
          a.primary_email AS "primaryEmail",
          a.primary_login AS "primaryLogin"
        FROM public.actor_aliases aa
        JOIN public.actors a ON a.id = aa.actor_id
        WHERE aa.project_id = ${input.projectId}
          AND aa.alias_type = ${input.aliasType}
          AND aa.alias_value = ${input.aliasValue}
        LIMIT 1
      `,
    );
  }

  async mergeGraphNode(input) {
    validateGraphName(input.graphName);
    validateGraphToken(input.label, 'graph label');
    const cypher = [
      `MERGE (n:${input.label} {key: ${cypherString(input.key)}})`,
      `SET n += ${cypherMap({ ...input.properties, key: input.key })}`,
      'RETURN n',
    ].join('\n');
    await runCypher(this.sql, input.graphName, cypher);
  }

  async mergeGraphEdge(input) {
    validateGraphName(input.graphName);
    validateGraphToken(input.type, 'graph edge type');
    const cypher = [
      `MATCH (from {key: ${cypherString(input.fromKey)}}), (to {key: ${cypherString(
        input.toKey,
      )}})`,
      `MERGE (from)-[edge:${input.type} {key: ${cypherString(input.key)}}]->(to)`,
      `SET edge += ${cypherMap({ ...input.properties, key: input.key })}`,
      'RETURN edge',
    ].join('\n');
    await runCypher(this.sql, input.graphName, cypher);
  }

  async replaceEmailQuotes(input) {
    await this.sql.begin(async (transaction) => {
      await transaction`
        DELETE FROM public.email_quotes
        WHERE project_id = ${input.projectId}
          AND document_id = ${input.documentId}
      `;

      const quoteIds = new Map();
      for (const quote of input.quotes) {
        const prevQuoteId =
          quote.prevQuoteIndex === undefined ? null : (quoteIds.get(quote.prevQuoteIndex) ?? null);
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
              ${quote.projectId},
              ${quote.documentId},
              ${quote.quoteIndex},
              ${quote.quotedMessageId},
              ${prevQuoteId},
              ${quote.senderAlias},
              ${quote.senderActorId ?? null},
              ${quote.sentAt},
              ${quote.body},
              ${transaction.json(quote.metadata)}
            )
            RETURNING id::text AS id
          `,
        );
        quoteIds.set(quote.quoteIndex, inserted.id);
      }
    });
  }

  async markIndexed(input) {
    await this.sql.begin(async (transaction) => {
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
}

async function setupAgeConnection(sql) {
  await sql.unsafe("LOAD 'age'");
  await sql.unsafe('SET search_path = ag_catalog, "$user", public');
}

async function runCypher(sql, graphName, cypher) {
  await sql.unsafe(
    `SELECT * FROM cypher(${sqlLiteral(graphName)}, $$${cypher.replaceAll('$$', '$ $')}$$) AS (value agtype)`,
  );
}

function cypherMap(properties) {
  const entries = Object.entries(properties).filter((entry) => entry[1] !== undefined);
  return `{${entries.map(([key, value]) => `${key}: ${cypherValue(value)}`).join(', ')}}`;
}

function cypherValue(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return cypherString(typeof value === 'string' ? value : JSON.stringify(value));
}

function cypherString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function validateGraphName(value) {
  if (!/^graph_[a-z0-9_]+$/.test(value) || value.length > 63) {
    throw new Error(`Invalid graph name: ${value}`);
  }
}

function validateGraphToken(value, label) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function createLocalObjectStorageFromEnv(env = process.env) {
  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required.');
  }
  return new LocalFsObjectStorage(root);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
