import postgres from 'postgres';
import type {
  GraphActorAliasType,
  GraphEdgeInput,
  GraphNodeInput,
  GraphRelationActorRecord,
  GraphRelationDocumentRecord,
  GraphRelationProjectRecord,
  GraphRelationsRepository,
  GraphRelationTarget,
  ReplaceEmailQuotesInput,
  SourceType,
} from '../packages/ingestion/dist/index.js';
import { storeGraphRelations } from '../packages/ingestion/dist/index.js';
import { createObjectStorageFromEnv } from '../packages/storage/dist/factory.js';
import type { ObjectStorage } from '../packages/storage/dist/object-storage.js';
import { requiredEnv, validateGraphName } from './lib/cli.ts';
import {
  extractRelatedDocumentSourceIds,
  parseAgtypeString,
  selectGraphIndexTargets,
  selectRelatedDocumentBackfillTargets,
} from './lib/graph-target-selection.ts';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];
const GRAPH_TARGET_SCAN_PAGE_MIN_SIZE = 100;
const GRAPH_TARGET_SCAN_PAGE_MULTIPLIER = 10;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createObjectStorageFromEnv(process.env);
  const repository = new PostgresGraphRelationsRepository(
    sql,
    storage,
    options.source,
    options.dataSourceId,
  );

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

type GraphTargetRow = {
  docType: GraphRelationDocumentRecord['docType'];
  documentId: string;
  documentRawDocumentId: string;
  graphNodeId: string;
  ingestStatus: string;
  parsedUri: string;
  rawContentHash: string;
  rawDocumentId: string;
  sourceId: string;
};

type InsertedEmailQuoteRow = {
  id: string;
  quoteIndex: number;
};

class PostgresGraphRelationsRepository implements GraphRelationsRepository {
  private dataSourceId: string | undefined;
  private sql: postgres.Sql;
  private storage: ObjectStorage;
  private sourceType: SourceType | undefined;
  private graphName: string | undefined;
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
    this.graphName = undefined;
  }

  async lookupProjectBySlug(slug: string): Promise<GraphRelationProjectRecord | undefined> {
    const project = singleJson(
      (await this.sql`
        SELECT graph_name AS "graphName", id::text AS id, slug
        FROM public.projects
        WHERE slug = ${slug}
      `) as GraphRelationProjectRecord[],
    );
    if (project) {
      this.graphName = validateGraphName(project.graphName);
      await ensureAgeSession(this.sql);
      await ensureGraph(this.sql, this.graphName);
    }
    return project;
  }

  async readGraphTargets(input: {
    limit: number;
    projectId: string;
  }): Promise<GraphRelationTarget[]> {
    const graphName = requiredGraphName(this.graphName);
    const selectedRows: GraphTargetRow[] = [];
    const parsedTextByRawDocumentId = new Map<string, string>();
    const pageSize = Math.max(
      input.limit * GRAPH_TARGET_SCAN_PAGE_MULTIPLIER,
      GRAPH_TARGET_SCAN_PAGE_MIN_SIZE,
    );
    let offset = 0;

    while (selectedRows.length < input.limit) {
      const rows = await this.readGraphTargetRows({ ...input, limit: pageSize, offset });
      if (rows.length === 0) {
        break;
      }
      const existingGraphNodeIds = await listExistingDocumentGraphNodeIds(
        this.sql,
        graphName,
        rows.map((row) => row.graphNodeId),
      );
      selectedRows.push(
        ...selectGraphIndexTargets(rows, existingGraphNodeIds, input.limit - selectedRows.length),
      );
      if (selectedRows.length < input.limit) {
        const selectedGraphNodeIds = new Set(selectedRows.map((row) => row.graphNodeId));
        for (const row of await this.selectRelatedDocumentBackfillRows({
          existingGraphNodeIds,
          graphName,
          limit: input.limit - selectedRows.length,
          parsedTextByRawDocumentId,
          projectId: input.projectId,
          rows,
          selectedGraphNodeIds,
        })) {
          if (selectedRows.length >= input.limit) {
            break;
          }
          if (selectedGraphNodeIds.has(row.graphNodeId)) {
            continue;
          }
          selectedRows.push(row);
          selectedGraphNodeIds.add(row.graphNodeId);
        }
      }
      if (rows.length < pageSize) {
        break;
      }
      offset += rows.length;
    }

    return Promise.all(
      selectedRows.map(
        async (row): Promise<GraphRelationTarget> => ({
          document: {
            docType: row.docType,
            graphNodeId: row.graphNodeId,
            id: row.documentId,
            rawDocumentId: row.documentRawDocumentId,
            sourceId: row.sourceId,
          },
          parsed: await this.readParsedText(row, parsedTextByRawDocumentId),
          rawContentHash: row.rawContentHash,
          rawDocumentId: row.rawDocumentId,
        }),
      ),
    );
  }

  private async selectRelatedDocumentBackfillRows(input: {
    existingGraphNodeIds: ReadonlySet<string>;
    graphName: string;
    limit: number;
    parsedTextByRawDocumentId: Map<string, string>;
    projectId: string;
    rows: readonly GraphTargetRow[];
    selectedGraphNodeIds: ReadonlySet<string>;
  }): Promise<GraphTargetRow[]> {
    const rowsWithParsed = (
      await Promise.all(
        input.rows
          .filter((row) => input.existingGraphNodeIds.has(row.graphNodeId))
          .map(async (row) => ({
            ...row,
            parsedText: await this.readParsedText(row, input.parsedTextByRawDocumentId),
          })),
      )
    ).filter((row) => extractRelatedDocumentSourceIds(row.parsedText).length > 0);
    if (rowsWithParsed.length === 0) {
      return [];
    }

    const targetSourceIdsByGraphNodeId = new Map<string, string[]>();
    const targetSourceIds = new Set<string>();
    for (const row of rowsWithParsed) {
      const sourceIds = extractRelatedDocumentSourceIds(row.parsedText).filter(
        (sourceId) => sourceId !== row.sourceId,
      );
      targetSourceIdsByGraphNodeId.set(row.graphNodeId, sourceIds);
      for (const sourceId of sourceIds) {
        targetSourceIds.add(sourceId);
      }
    }
    if (targetSourceIds.size === 0) {
      return [];
    }

    const documentsBySourceId = new Map(
      (
        await this.findDocumentsBySourceIds({
          projectId: input.projectId,
          sourceIds: [...targetSourceIds],
        })
      ).map((document) => [document.sourceId, document]),
    );
    const pairs = rowsWithParsed.flatMap((row) =>
      (targetSourceIdsByGraphNodeId.get(row.graphNodeId) ?? [])
        .map((sourceId) => documentsBySourceId.get(sourceId))
        .filter(
          (document): document is GraphRelationDocumentRecord =>
            document !== undefined && document.graphNodeId !== row.graphNodeId,
        )
        .map((document) => ({
          fromGraphNodeId: row.graphNodeId,
          toGraphNodeId: document.graphNodeId,
        })),
    );
    const existingEdgeKeys = await listExistingRelatedDocumentEdgeKeys(
      this.sql,
      input.graphName,
      pairs,
    );
    const missingRelatedEdgeGraphNodeIds = new Set(
      pairs
        .filter(
          (pair) =>
            !existingEdgeKeys.has(relatedDocumentEdgeKey(pair.fromGraphNodeId, pair.toGraphNodeId)),
        )
        .map((pair) => pair.fromGraphNodeId),
    );

    return selectRelatedDocumentBackfillTargets(
      rowsWithParsed,
      input.existingGraphNodeIds,
      missingRelatedEdgeGraphNodeIds,
      input.limit,
    )
      .filter((row) => !input.selectedGraphNodeIds.has(row.graphNodeId))
      .map(stripParsedText);
  }

  private async readParsedText(
    row: GraphTargetRow,
    parsedTextByRawDocumentId: Map<string, string>,
  ): Promise<string> {
    const cached = parsedTextByRawDocumentId.get(row.rawDocumentId);
    if (cached !== undefined) {
      return cached;
    }
    const parsedText = await this.storage.getText(row.parsedUri);
    parsedTextByRawDocumentId.set(row.rawDocumentId, parsedText);
    return parsedText;
  }

  private async readGraphTargetRows(input: {
    limit: number;
    offset: number;
    projectId: string;
  }): Promise<GraphTargetRow[]> {
    return (await this.sql`
      SELECT
        d.doc_type AS "docType",
        d.graph_node_id AS "graphNodeId",
        d.id::text AS "documentId",
        d.raw_document_id::text AS "documentRawDocumentId",
        rd.content_hash AS "rawContentHash",
        rd.id::text AS "rawDocumentId",
        rd.ingest_status AS "ingestStatus",
        rd.parsed_uri AS "parsedUri",
        rd.source_id AS "sourceId"
      FROM public.documents d
      JOIN public.raw_documents rd ON rd.id = d.raw_document_id
      WHERE d.project_id = ${input.projectId}
        AND rd.project_id = ${input.projectId}
        AND rd.parsed_uri IS NOT NULL
        AND rd.ingest_status IN ('parsed', 'indexed')
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
      ORDER BY
        rd.ingest_status DESC,
        rd.parsed_at NULLS LAST,
        rd.fetched_at,
        rd.id
      LIMIT ${input.limit}
      OFFSET ${input.offset}
    `) as GraphTargetRow[];
  }

  async findActorByAlias(input: {
    aliasType: GraphActorAliasType;
    aliasValue: string;
    projectId: string;
  }): Promise<GraphRelationActorRecord | undefined> {
    return singleJson(
      (await this.sql`
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
      `) as GraphRelationActorRecord[],
    );
  }

  async findActorByGraphNodeId(input: {
    graphNodeId: string;
    projectId: string;
  }): Promise<GraphRelationActorRecord | undefined> {
    return singleJson(
      (await this.sql`
        SELECT
          display_name AS "displayName",
          graph_node_id AS "graphNodeId",
          id::text AS id
        FROM public.actors
        WHERE project_id = ${input.projectId}
          AND graph_node_id = ${input.graphNodeId}
        LIMIT 1
      `) as GraphRelationActorRecord[],
    );
  }

  async findSameAsDocuments(input: {
    projectId: string;
    rawContentHash: string;
    rawDocumentId: string;
    sourceType: SourceType;
  }): Promise<GraphRelationDocumentRecord[]> {
    return (await this.sql`
      SELECT
        d.doc_type AS "docType",
        d.graph_node_id AS "graphNodeId",
        d.id::text AS id,
        d.raw_document_id::text AS "rawDocumentId",
        rd.source_id AS "sourceId"
      FROM public.documents d
      JOIN public.raw_documents rd ON rd.id = d.raw_document_id
      WHERE d.project_id = ${input.projectId}
        AND rd.project_id = ${input.projectId}
        AND rd.id <> ${input.rawDocumentId}
        AND rd.source_type <> ${input.sourceType}
        AND rd.content_hash = ${input.rawContentHash}
    `) as GraphRelationDocumentRecord[];
  }

  async findDocumentsBySourceIds(input: {
    projectId: string;
    sourceIds: readonly string[];
  }): Promise<GraphRelationDocumentRecord[]> {
    if (input.sourceIds.length === 0) {
      return [];
    }
    return (await this.sql`
        SELECT
          d.doc_type AS "docType",
          d.graph_node_id AS "graphNodeId",
          d.id::text AS id,
          d.raw_document_id::text AS "rawDocumentId",
          rd.source_id AS "sourceId"
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        WHERE d.project_id = ${input.projectId}
          AND rd.project_id = ${input.projectId}
          AND rd.source_id IN ${this.sql(input.sourceIds)}
      `) as GraphRelationDocumentRecord[];
  }

  async upsertGraphNode(input: GraphNodeInput): Promise<void> {
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

  async upsertGraphEdge(input: GraphEdgeInput): Promise<void> {
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

  async replaceEmailQuotes(input: ReplaceEmailQuotesInput): Promise<void> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<void> => {
      await transaction`
        DELETE FROM public.email_quotes
        WHERE project_id = ${input.projectId}
          AND document_id = ${input.documentId}
      `;
      const insertedByIndex = new Map<number, string>();
      const sortedQuotes = [...input.quotes].sort((a, b) => a.quoteIndex - b.quoteIndex);
      for (const quote of sortedQuotes) {
        const inserted = singleJson(
          (await transaction`
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
          `) as InsertedEmailQuoteRow[],
        );
        if (!inserted) {
          throw new Error('Failed to insert email quote.');
        }
        insertedByIndex.set(inserted.quoteIndex, inserted.id);
      }
    });
  }

  async markIndexed(input: { projectId: string; rawDocumentId: string }): Promise<void> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<void> => {
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

  async markFailed(input: {
    errorMessage: string;
    projectId: string;
    rawDocumentId: string;
  }): Promise<void> {
    await this.sql.begin(async (transaction: postgres.TransactionSql): Promise<void> => {
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

async function listExistingDocumentGraphNodeIds(
  sql: postgres.Sql,
  graphName: string,
  graphNodeIds: readonly string[],
): Promise<Set<string>> {
  if (graphNodeIds.length === 0) {
    return new Set();
  }
  const rows = (await sql.unsafe(
    `SELECT graph_node_id FROM cypher(${sqlString(graphName)}, ${dollarQuote(
      'MATCH (n:Document) WHERE n.graphNodeId IN $graphNodeIds RETURN n.graphNodeId',
    )}, $1::agtype) AS (graph_node_id agtype)`,
    [JSON.stringify({ graphNodeIds })],
  )) as Array<{ graph_node_id: unknown }>;
  return new Set(
    rows
      .map((row) => parseAgtypeString(row.graph_node_id))
      .filter((graphNodeId): graphNodeId is string => graphNodeId !== undefined),
  );
}

async function listExistingRelatedDocumentEdgeKeys(
  sql: postgres.Sql,
  graphName: string,
  pairs: ReadonlyArray<{ fromGraphNodeId: string; toGraphNodeId: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) {
    return new Set();
  }
  const fromGraphNodeIds = [...new Set(pairs.map((pair) => pair.fromGraphNodeId))];
  const toGraphNodeIds = [...new Set(pairs.map((pair) => pair.toGraphNodeId))];
  const rows = (await sql.unsafe(
    `SELECT from_graph_node_id, to_graph_node_id FROM cypher(${sqlString(graphName)}, ${dollarQuote(
      [
        'MATCH (from:Document)-[:RELATED_TO]->(to:Document)',
        'WHERE from.graphNodeId IN $fromGraphNodeIds',
        'AND to.graphNodeId IN $toGraphNodeIds',
        'RETURN from.graphNodeId, to.graphNodeId',
      ].join(' '),
    )}, $1::agtype) AS (from_graph_node_id agtype, to_graph_node_id agtype)`,
    [JSON.stringify({ fromGraphNodeIds, toGraphNodeIds })],
  )) as Array<{ from_graph_node_id: unknown; to_graph_node_id: unknown }>;
  return new Set(
    rows
      .map((row) => {
        const fromGraphNodeId = parseAgtypeString(row.from_graph_node_id);
        const toGraphNodeId = parseAgtypeString(row.to_graph_node_id);
        return fromGraphNodeId && toGraphNodeId
          ? relatedDocumentEdgeKey(fromGraphNodeId, toGraphNodeId)
          : undefined;
      })
      .filter((key): key is string => key !== undefined),
  );
}

function relatedDocumentEdgeKey(fromGraphNodeId: string, toGraphNodeId: string): string {
  return `${fromGraphNodeId}\u001f${toGraphNodeId}`;
}

function stripParsedText<T extends { parsedText: string }>(row: T): Omit<T, 'parsedText'> {
  const { parsedText: _parsedText, ...rest } = row;
  return rest;
}

function parseArgs(argv: string[]): {
  dataSourceId?: string;
  project?: string;
  source?: SourceType;
  limit?: number;
} {
  const options: {
    dataSourceId?: string;
    project?: string;
    source?: SourceType;
    limit?: number;
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

function singleJson<T>(rows: T[]): T | undefined {
  return rows[0];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateLabel(label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) {
    throw new Error(`Invalid graph label or edge type: ${label}`);
  }
  return label;
}

function parameterizedSetClause(
  variableName: string,
  properties: Record<string, unknown> | null | undefined,
  paramPrefix: string,
): { cypher: string; params: Record<string, unknown> } {
  const assignments: string[] = [];
  const params: Record<string, unknown> = {};
  let index = 0;
  for (const [propertyName, value] of Object.entries(properties ?? {})) {
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
