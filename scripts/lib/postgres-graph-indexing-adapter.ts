import {
  type GraphIndexingActorRecord,
  type GraphIndexingDocumentRecord,
  type GraphIndexingRepository,
  type GraphIndexingTarget,
  type ProjectResolver,
  parseGraphIndexingDocumentType,
  parseGraphProjectResolverResult,
  type ReplaceGraphIndexingEmailQuotesInput,
} from '@pufu-lens/graph';
import type { ObjectStorage } from '@pufu-lens/storage';
import type postgres from 'postgres';
import type { SourceType } from '../../packages/ingestion/dist/index.js';
import { validateGraphName } from './cli.ts';
import {
  extractRelatedDocumentSourceIds,
  parseAgtypeString,
  selectGraphIndexTargets,
  selectRelatedDocumentBackfillTargets,
} from './graph-target-selection.ts';

const RESUME_CURSOR_PATTERN = /^[0-9a-f]{64}$/;

/** postgres.js executor accepted by graph indexing adapters. */
export type PostgresGraphExecutor = postgres.Sql | postgres.TransactionSql;

/** Rebuild indexing repository with digest-based resume cursor support. */
export interface GraphRebuildIndexingRepository extends GraphIndexingRepository {
  readGraphTargets(input: {
    readonly limit: number;
    readonly projectId: string;
    readonly resumeCursor?: string;
  }): Promise<readonly GraphIndexingTarget[]>;
}

async function withIndexingTransaction<T>(
  sql: PostgresGraphExecutor,
  callback: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (isSqlExecutor(sql)) {
    const result = await sql.begin(callback);
    return result as T;
  }
  return callback(sql);
}

function isSqlExecutor(executor: PostgresGraphExecutor): executor is postgres.Sql {
  return 'begin' in executor && typeof executor.begin === 'function';
}

export const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'] as const;

export const GRAPH_INDEX_TARGET_SCAN_PAGE_MIN_SIZE = 100;
export const GRAPH_INDEX_TARGET_SCAN_PAGE_MULTIPLIER = 10;
export const GRAPH_RELATED_PARSED_TEXT_READ_CONCURRENCY = 10;
/** Maximum concurrent Object Storage reads while loading rebuild graph targets. */
export const GRAPH_REBUILD_PARSED_TEXT_READ_CONCURRENCY = 8;

/** CLI options accepted by `index-graph-relations`. */
export type IndexGraphRelationsCliOptions = {
  readonly dataSourceId?: string;
  readonly project?: string;
  readonly source?: SourceType;
  readonly limit?: number;
};

type MutableIndexGraphRelationsCliOptions = {
  dataSourceId?: string;
  project?: string;
  source?: SourceType;
  limit?: number;
};

type GraphTargetRow = {
  readonly docType: GraphIndexingDocumentRecord['docType'];
  readonly documentId: string;
  readonly documentRawDocumentId: string;
  readonly graphNodeId: string;
  readonly ingestStatus: 'parsed' | 'indexed';
  readonly parsedUri: string;
  readonly rawContentHash: string;
  readonly rawDocumentId: string;
  readonly sourceId: string;
};

type InsertedEmailQuoteRow = {
  readonly id: string;
  readonly quoteIndex: number;
};

/** Creates a PostgreSQL-backed project resolver for graph indexing workflows. */
export function createPostgresGraphProjectResolver(sql: PostgresGraphExecutor): ProjectResolver {
  return {
    async resolveBySlug(slug: string) {
      const rows = (await sql`
        SELECT id::text AS "projectId", slug AS "projectSlug"
        FROM public.projects
        WHERE slug = ${slug}
        LIMIT 1
      `) as unknown as unknown[];
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      return parseGraphProjectResolverResult(parseProjectResolverRow(row));
    },
  };
}

/** Creates a PostgreSQL-backed graph indexing repository for ingestion workflows. */
export function createPostgresGraphIndexingRepository(
  sql: PostgresGraphExecutor,
  storage: ObjectStorage,
  filters: {
    readonly dataSourceId?: string;
    readonly sourceType?: SourceType;
  } = {},
): GraphIndexingRepository {
  return new PostgresGraphIndexingRepository(
    sql,
    storage,
    filters.sourceType,
    filters.dataSourceId,
  );
}

/**
 * Creates a rebuild-only graph indexing repository that reads current parsed documents
 * with digest-based resume cursors and without AGE selection heuristics.
 */
export function createPostgresGraphRebuildIndexingRepository(
  sql: PostgresGraphExecutor,
  storage: ObjectStorage,
): GraphRebuildIndexingRepository {
  return new PostgresGraphRebuildIndexingRepository(
    new PostgresGraphIndexingRepository(sql, storage, undefined, undefined),
    sql,
    storage,
  );
}

/** Parses argv for `index-graph-relations` without executing side effects. */
export function parseIndexGraphRelationsCliArgs(argv: string[]): IndexGraphRelationsCliOptions {
  const options: MutableIndexGraphRelationsCliOptions = {};
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

class PostgresGraphIndexingRepository implements GraphIndexingRepository {
  private readonly dataSourceId: string | undefined;
  private readonly sourceType: SourceType | undefined;
  private readonly sql: PostgresGraphExecutor;
  private readonly storage: ObjectStorage;

  constructor(
    sql: PostgresGraphExecutor,
    storage: ObjectStorage,
    sourceType: SourceType | undefined,
    dataSourceId: string | undefined,
  ) {
    this.sql = sql;
    this.storage = storage;
    this.sourceType = sourceType;
    this.dataSourceId = dataSourceId;
  }

  async readGraphTargets(input: {
    readonly limit: number;
    readonly projectId: string;
  }): Promise<readonly GraphIndexingTarget[]> {
    const graphName = await resolveProjectGraphName(this.sql, input.projectId);
    const selectedRows: GraphTargetRow[] = [];
    const parsedTextByRawDocumentId = new Map<string, string>();
    const pageSize = Math.max(
      input.limit * GRAPH_INDEX_TARGET_SCAN_PAGE_MULTIPLIER,
      GRAPH_INDEX_TARGET_SCAN_PAGE_MIN_SIZE,
    );
    let offset = 0;

    while (selectedRows.length < input.limit) {
      const rows = await this.readGraphTargetRows({ ...input, limit: pageSize, offset });
      if (rows.length === 0) {
        break;
      }
      const existingGraphNodeIds = graphName
        ? await listExistingDocumentGraphNodeIds(
            this.sql,
            graphName,
            rows.map((row) => row.graphNodeId),
          )
        : new Set<string>();
      selectedRows.push(
        ...selectGraphIndexTargets(rows, existingGraphNodeIds, input.limit - selectedRows.length),
      );
      if (selectedRows.length < input.limit && graphName) {
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
        async (row): Promise<GraphIndexingTarget> => ({
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
    readonly existingGraphNodeIds: ReadonlySet<string>;
    readonly graphName: string;
    readonly limit: number;
    readonly parsedTextByRawDocumentId: Map<string, string>;
    readonly projectId: string;
    readonly rows: readonly GraphTargetRow[];
    readonly selectedGraphNodeIds: ReadonlySet<string>;
  }): Promise<GraphTargetRow[]> {
    const candidateRows = input.rows.filter((row) =>
      input.existingGraphNodeIds.has(row.graphNodeId),
    );
    const rowsWithParsed: Array<GraphTargetRow & { parsedText: string }> = [];
    for (
      let start = 0;
      start < candidateRows.length;
      start += GRAPH_RELATED_PARSED_TEXT_READ_CONCURRENCY
    ) {
      const slice = candidateRows.slice(start, start + GRAPH_RELATED_PARSED_TEXT_READ_CONCURRENCY);
      const parsedSlice = await Promise.all(
        slice.map(async (row) => ({
          ...row,
          parsedText: await this.readParsedText(row, input.parsedTextByRawDocumentId),
        })),
      );
      for (const row of parsedSlice) {
        if (extractRelatedDocumentSourceIds(row.parsedText).length > 0) {
          rowsWithParsed.push(row);
        }
      }
    }
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
          (document): document is GraphIndexingDocumentRecord =>
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
    readonly limit: number;
    readonly offset: number;
    readonly projectId: string;
  }): Promise<GraphTargetRow[]> {
    const rows = (await this.sql`
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
    `) as unknown as unknown[];
    return rows.map(parseGraphTargetRow);
  }

  async findActorByAlias(input: {
    readonly aliasType: 'email' | 'github_login' | 'domain';
    readonly aliasValue: string;
    readonly projectId: string;
  }): Promise<GraphIndexingActorRecord | undefined> {
    const rows = (await this.sql`
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
    `) as unknown as unknown[];
    const row = rows[0];
    return row ? parseGraphIndexingActorRow(row) : undefined;
  }

  async findActorByGraphNodeId(input: {
    readonly graphNodeId: string;
    readonly projectId: string;
  }): Promise<GraphIndexingActorRecord | undefined> {
    const rows = (await this.sql`
      SELECT
        display_name AS "displayName",
        graph_node_id AS "graphNodeId",
        id::text AS id
      FROM public.actors
      WHERE project_id = ${input.projectId}
        AND graph_node_id = ${input.graphNodeId}
      LIMIT 1
    `) as unknown as unknown[];
    const row = rows[0];
    return row ? parseGraphIndexingActorRow(row) : undefined;
  }

  async findSameAsDocuments(input: {
    readonly projectId: string;
    readonly rawContentHash: string;
    readonly rawDocumentId: string;
    readonly sourceType: string;
  }): Promise<readonly GraphIndexingDocumentRecord[]> {
    const rows = (await this.sql`
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
    `) as unknown as unknown[];
    return rows.map(parseGraphIndexingDocumentRow);
  }

  async findDocumentsBySourceIds(input: {
    readonly projectId: string;
    readonly sourceIds: readonly string[];
  }): Promise<readonly GraphIndexingDocumentRecord[]> {
    if (input.sourceIds.length === 0) {
      return [];
    }
    const rows = (await this.sql`
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
    `) as unknown as unknown[];
    return rows.map(parseGraphIndexingDocumentRow);
  }

  async replaceEmailQuotes(input: ReplaceGraphIndexingEmailQuotesInput): Promise<void> {
    await withIndexingTransaction(this.sql, async (transaction): Promise<void> => {
      await transaction`
        DELETE FROM public.email_quotes
        WHERE project_id = ${input.projectId}
          AND document_id = ${input.documentId}
      `;
      const insertedByIndex = new Map<number, string>();
      const sortedQuotes = [...input.quotes].sort((a, b) => a.quoteIndex - b.quoteIndex);
      for (const quote of sortedQuotes) {
        const inserted = parseInsertedEmailQuoteRow(
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
          `) as unknown as unknown[],
        );
        insertedByIndex.set(inserted.quoteIndex, inserted.id);
      }
    });
  }

  async markIndexed(input: {
    readonly projectId: string;
    readonly rawDocumentId: string;
  }): Promise<void> {
    await withIndexingTransaction(this.sql, async (transaction): Promise<void> => {
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
    readonly errorMessage: string;
    readonly projectId: string;
    readonly rawDocumentId: string;
  }): Promise<void> {
    await withIndexingTransaction(this.sql, async (transaction): Promise<void> => {
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

class PostgresGraphRebuildIndexingRepository implements GraphRebuildIndexingRepository {
  private readonly delegate: PostgresGraphIndexingRepository;
  private readonly sql: PostgresGraphExecutor;
  private readonly storage: ObjectStorage;

  constructor(
    delegate: PostgresGraphIndexingRepository,
    sql: PostgresGraphExecutor,
    storage: ObjectStorage,
  ) {
    this.delegate = delegate;
    this.sql = sql;
    this.storage = storage;
  }

  findActorByAlias(
    input: Parameters<GraphIndexingRepository['findActorByAlias']>[0],
  ): ReturnType<GraphIndexingRepository['findActorByAlias']> {
    return this.delegate.findActorByAlias(input);
  }

  findActorByGraphNodeId(
    input: Parameters<GraphIndexingRepository['findActorByGraphNodeId']>[0],
  ): ReturnType<GraphIndexingRepository['findActorByGraphNodeId']> {
    return this.delegate.findActorByGraphNodeId(input);
  }

  findDocumentsBySourceIds(
    input: Parameters<GraphIndexingRepository['findDocumentsBySourceIds']>[0],
  ): ReturnType<GraphIndexingRepository['findDocumentsBySourceIds']> {
    return this.delegate.findDocumentsBySourceIds(input);
  }

  findSameAsDocuments(
    input: Parameters<GraphIndexingRepository['findSameAsDocuments']>[0],
  ): ReturnType<GraphIndexingRepository['findSameAsDocuments']> {
    return this.delegate.findSameAsDocuments(input);
  }

  markFailed(
    input: Parameters<GraphIndexingRepository['markFailed']>[0],
  ): ReturnType<GraphIndexingRepository['markFailed']> {
    return this.delegate.markFailed(input);
  }

  markIndexed(
    input: Parameters<GraphIndexingRepository['markIndexed']>[0],
  ): ReturnType<GraphIndexingRepository['markIndexed']> {
    return this.delegate.markIndexed(input);
  }

  replaceEmailQuotes(
    input: Parameters<GraphIndexingRepository['replaceEmailQuotes']>[0],
  ): ReturnType<GraphIndexingRepository['replaceEmailQuotes']> {
    return this.delegate.replaceEmailQuotes(input);
  }

  async readGraphTargets(input: {
    readonly limit: number;
    readonly projectId: string;
    readonly resumeCursor?: string;
  }): Promise<readonly GraphIndexingTarget[]> {
    if (input.resumeCursor !== undefined && !RESUME_CURSOR_PATTERN.test(input.resumeCursor)) {
      throw new Error('resume cursor must be a 64-character lowercase hex digest.');
    }
    const rows = await this.readRebuildGraphTargetRows(input);
    return mapWithBoundedConcurrency(
      rows,
      GRAPH_REBUILD_PARSED_TEXT_READ_CONCURRENCY,
      async (row): Promise<GraphIndexingTarget> => ({
        document: {
          docType: row.docType,
          graphNodeId: row.graphNodeId,
          id: row.documentId,
          rawDocumentId: row.documentRawDocumentId,
          sourceId: row.sourceId,
        },
        parsed: await this.readParsedText(row),
        rawContentHash: row.rawContentHash,
        rawDocumentId: row.rawDocumentId,
      }),
    );
  }

  private async readParsedText(row: GraphTargetRow): Promise<string> {
    return this.storage.getText(row.parsedUri);
  }

  private async readRebuildGraphTargetRows(input: {
    readonly limit: number;
    readonly projectId: string;
    readonly resumeCursor?: string;
  }): Promise<GraphTargetRow[]> {
    const rows = (await this.sql`
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
        AND (
          ${input.resumeCursor ?? null}::text IS NULL
          OR encode(sha256(convert_to(rd.id::text, 'UTF8')), 'hex') > ${input.resumeCursor ?? null}
        )
      ORDER BY encode(sha256(convert_to(rd.id::text, 'UTF8')), 'hex'), rd.id
      LIMIT ${input.limit}
    `) as readonly unknown[];
    return rows.map(parseGraphTargetRow);
  }
}

function parseProjectResolverRow(row: unknown): { projectId: string; projectSlug: string } {
  if (!isRecord(row)) {
    throw new Error('Invalid project resolver row.');
  }
  return parseGraphProjectResolverResult({
    projectId: row.projectId,
    projectSlug: row.projectSlug,
  });
}

function parseGraphIndexingActorRow(row: unknown): GraphIndexingActorRecord {
  if (!isRecord(row)) {
    throw new Error('Invalid graph indexing actor row.');
  }
  return {
    displayName: requireNonEmptyString(row.displayName, 'displayName'),
    graphNodeId: requireNonEmptyString(row.graphNodeId, 'graphNodeId'),
    id: requireNonEmptyString(row.id, 'id'),
  };
}

function parseGraphIndexingDocumentRow(row: unknown): GraphIndexingDocumentRecord {
  if (!isRecord(row)) {
    throw new Error('Invalid graph indexing document row.');
  }
  return {
    docType: parseGraphIndexingDocumentType(row.docType),
    graphNodeId: requireNonEmptyString(row.graphNodeId, 'graphNodeId'),
    id: requireNonEmptyString(row.id, 'id'),
    rawDocumentId: requireNonEmptyString(row.rawDocumentId, 'rawDocumentId'),
    sourceId: requireNonEmptyString(row.sourceId, 'sourceId'),
  };
}

function parseGraphTargetRow(row: unknown): GraphTargetRow {
  if (!isRecord(row)) {
    throw new Error('Invalid graph target row.');
  }
  const ingestStatus = row.ingestStatus;
  if (ingestStatus !== 'parsed' && ingestStatus !== 'indexed') {
    throw new Error('Invalid graph target row field: ingestStatus');
  }
  return {
    docType: parseGraphIndexingDocumentType(row.docType),
    documentId: requireNonEmptyString(row.documentId, 'documentId'),
    documentRawDocumentId: requireNonEmptyString(
      row.documentRawDocumentId,
      'documentRawDocumentId',
    ),
    graphNodeId: requireNonEmptyString(row.graphNodeId, 'graphNodeId'),
    ingestStatus,
    parsedUri: requireNonEmptyString(row.parsedUri, 'parsedUri'),
    rawContentHash: requireNonEmptyString(row.rawContentHash, 'rawContentHash'),
    rawDocumentId: requireNonEmptyString(row.rawDocumentId, 'rawDocumentId'),
    sourceId: requireNonEmptyString(row.sourceId, 'sourceId'),
  };
}

function parseInsertedEmailQuoteRow(rows: unknown[]): InsertedEmailQuoteRow {
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Failed to insert email quote.');
  }
  const quoteIndex = row.quoteIndex;
  if (typeof quoteIndex !== 'number' || !Number.isInteger(quoteIndex)) {
    throw new Error('Invalid inserted email quote row field: quoteIndex');
  }
  return {
    id: requireNonEmptyString(row.id, 'id'),
    quoteIndex,
  };
}

async function resolveProjectGraphName(
  sql: PostgresGraphExecutor,
  projectId: string,
): Promise<string | undefined> {
  const rows = (await sql`
    SELECT graph_name AS "graphName"
    FROM public.projects
    WHERE id = ${projectId}::uuid
    LIMIT 1
  `) as unknown as unknown[];
  if (rows.length === 0) {
    return undefined;
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid project graph lookup row.');
  }
  const graphName = row.graphName;
  if (graphName === null || typeof graphName !== 'string' || graphName.trim().length === 0) {
    return undefined;
  }
  return validateGraphName(graphName);
}

async function listExistingDocumentGraphNodeIds(
  sql: PostgresGraphExecutor,
  graphName: string,
  graphNodeIds: readonly string[],
): Promise<Set<string>> {
  if (graphNodeIds.length === 0) {
    return new Set();
  }
  await ensureAgeSession(sql);
  const rows = (await sql.unsafe(
    `SELECT graph_node_id FROM cypher(${sqlString(graphName)}, ${dollarQuote(
      'MATCH (n:Document) WHERE n.graphNodeId IN $graphNodeIds RETURN n.graphNodeId',
    )}, $1::agtype) AS (graph_node_id agtype)`,
    [JSON.stringify({ graphNodeIds })],
  )) as unknown as unknown[];
  return new Set(
    rows.map((row) => {
      if (!isRecord(row)) {
        throw new Error('Invalid AGE document graph node row.');
      }
      const graphNodeId = parseAgtypeString(row.graph_node_id);
      if (graphNodeId === undefined) {
        throw new Error('Invalid AGE document graph node row.');
      }
      return graphNodeId;
    }),
  );
}

async function listExistingRelatedDocumentEdgeKeys(
  sql: PostgresGraphExecutor,
  graphName: string,
  pairs: ReadonlyArray<{ fromGraphNodeId: string; toGraphNodeId: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) {
    return new Set();
  }
  await ensureAgeSession(sql);
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
  )) as unknown as unknown[];
  return new Set(
    rows.map((row) => {
      if (!isRecord(row)) {
        throw new Error('Invalid AGE related document edge row.');
      }
      const fromGraphNodeId = parseAgtypeString(row.from_graph_node_id);
      const toGraphNodeId = parseAgtypeString(row.to_graph_node_id);
      if (fromGraphNodeId === undefined || toGraphNodeId === undefined) {
        throw new Error('Invalid AGE related document edge row.');
      }
      return relatedDocumentEdgeKey(fromGraphNodeId, toGraphNodeId);
    }),
  );
}

async function ensureAgeSession(sql: PostgresGraphExecutor): Promise<void> {
  await sql.unsafe("LOAD 'age'");
  await sql.unsafe('SET search_path = ag_catalog, "$user", public');
}

function relatedDocumentEdgeKey(fromGraphNodeId: string, toGraphNodeId: string): string {
  return `${fromGraphNodeId}\u001f${toGraphNodeId}`;
}

function stripParsedText<T extends { parsedText: string }>(row: T): Omit<T, 'parsedText'> {
  const { parsedText: _parsedText, ...rest } = row;
  return rest;
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

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  return `$pufu_static$${value}$pufu_static$`;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid graph indexing row field: ${fieldName}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += concurrency) {
    const slice = items.slice(start, start + concurrency);
    const sliceResults = await Promise.all(
      slice.map((item, offset) => mapper(item, start + offset)),
    );
    results.push(...sliceResults);
  }
  return results;
}
