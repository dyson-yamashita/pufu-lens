import { createHash } from 'node:crypto';
import type {
  GraphIndexingRepository,
  GraphMutationRepository,
  GraphRelationType,
  ProjectResolver,
} from '@pufu-lens/graph';
import {
  canonicalizeSameAsEdgeEndpoints,
  createPostgresRelationalGraphMutationRepository,
} from '@pufu-lens/graph/postgres-relational-mutation';
import type postgres from 'postgres';
import { storeGraphRelations } from '../../packages/ingestion/dist/index.js';
import type { ObjectStorage } from '../../packages/storage/dist/object-storage.js';
import {
  compareGraphInventories,
  type GraphInventoryComparisonSummary,
} from './graph-migration-audit.ts';
import {
  createPostgresGraphRebuildIndexingRepository,
  type PostgresGraphExecutor,
} from './postgres-graph-indexing-adapter.ts';
import {
  readAgeGraphInventory,
  readRelationalGraphInventory,
  validateGraphInventoryLimit,
} from './postgres-graph-inventory.ts';
import { auditGraphSourceOfTruth } from './postgres-graph-source-audit.ts';

/** PostgreSQL transaction preamble for graph compare snapshot reads. */
export const GRAPH_COMPARE_TRANSACTION_SQL =
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';

/** Sanitized rebuild batch result without raw document or node identities. */
export type GraphRebuildResult = {
  readonly dryRun: boolean;
  readonly duplicateAttemptCount: number;
  readonly edgeCount: number;
  readonly failedCount: number;
  readonly hasMore: boolean;
  readonly nextResumeCursor?: string;
  readonly nodeCount: number;
  readonly processedCount: number;
};

/** Sanitized compare result without inventory identities or provider queries. */
export type GraphCompareResult = GraphInventoryComparisonSummary;

type RebuildRunInput = {
  readonly dryRun: boolean;
  readonly limit: number;
  readonly projectSlug: string;
  readonly resumeCursor?: string;
  readonly sql: postgres.Sql;
  readonly storage: ObjectStorage;
};

type CompareRunInput = {
  readonly limit: number;
  readonly projectSlug: string;
  readonly sql: postgres.Sql;
};

/**
 * Rebuilds relational graph rows from current parsed documents for one project.
 * Dry-run collects unique node/edge counts without writing; execute runs in one transaction.
 */
export async function runGraphRebuild(input: RebuildRunInput): Promise<GraphRebuildResult> {
  const projectResolver = createProjectResolver(input.sql);
  const project = await projectResolver.resolveBySlug(input.projectSlug);
  if (!project) {
    throw new Error('Project not found.');
  }

  const indexingRepository = createRebuildIndexingRepository(
    input.sql,
    input.storage,
    input.resumeCursor,
  );
  const collector = new DryRunGraphMutationCollector();

  if (input.dryRun) {
    const result = await storeGraphRelations({
      indexingRepository,
      limit: input.limit,
      mode: 'rebuild',
      mutationRepository: collector,
      projectResolver,
      projectSlug: input.projectSlug,
    });
    return buildRebuildResult({
      collector,
      decisions: result.decisions,
      dryRun: true,
      limit: input.limit,
    });
  }

  let rebuildResult: GraphRebuildResult | undefined;

  await input.sql.begin(async (transaction) => {
    const projectResolverInTransaction = createProjectResolver(transaction);
    const transactionalIndexingRepository = createRebuildIndexingRepository(
      transaction,
      input.storage,
      input.resumeCursor,
    );
    const countingCollector = new DryRunGraphMutationCollector();
    const mutationRepository = wrapMutationRepository(
      createPostgresRelationalGraphMutationRepository(transaction),
      countingCollector,
    );
    const result = await storeGraphRelations({
      indexingRepository: transactionalIndexingRepository,
      limit: input.limit,
      mode: 'rebuild',
      mutationRepository,
      projectResolver: projectResolverInTransaction,
      projectSlug: input.projectSlug,
    });
    const failedCount = result.decisions.filter(
      (decision) => decision.decision === 'failed',
    ).length;
    if (failedCount > 0) {
      throw new Error('Graph rebuild batch failed.');
    }
    rebuildResult = buildRebuildResult({
      collector: countingCollector,
      decisions: result.decisions,
      dryRun: false,
      limit: input.limit,
    });
  });

  if (!rebuildResult) {
    throw new Error('Graph rebuild batch failed.');
  }
  return rebuildResult;
}

/**
 * Compares AGE and relational inventories plus source-of-truth audit counts for one project.
 */
export async function runGraphCompare(input: CompareRunInput): Promise<GraphCompareResult> {
  try {
    return await input.sql.begin(async (transaction) => {
      await establishGraphCompareSnapshotTransaction(transaction);
      const projectResolver = createProjectResolver(transaction);
      const project = await projectResolver.resolveBySlug(input.projectSlug);
      if (!project) {
        throw new Error('Project not found.');
      }
      const validatedLimit = validateGraphInventoryLimit(input.limit);
      const age = await readAgeGraphInventory(transaction, project.projectId, validatedLimit);
      const relational = await readRelationalGraphInventory(
        transaction,
        project.projectId,
        validatedLimit,
      );
      const sourceAudit = await auditGraphSourceOfTruth(transaction, project.projectId);
      return compareGraphInventories({ age, relational, sourceAudit });
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Project not found.') {
      throw error;
    }
    throw new Error('Graph compare failed.');
  }
}

/** Pins one transaction to a repeatable-read, read-only compare snapshot. */
export async function establishGraphCompareSnapshotTransaction(
  transaction: PostgresGraphExecutor,
): Promise<void> {
  await transaction.unsafe(GRAPH_COMPARE_TRANSACTION_SQL);
}

function createProjectResolver(sql: PostgresGraphExecutor): ProjectResolver {
  return {
    async resolveBySlug(slug: string) {
      const rows = (await sql`
        SELECT id::text AS "projectId", slug AS "projectSlug"
        FROM public.projects
        WHERE slug = ${slug}
        LIMIT 1
      `) as readonly unknown[];
      const row = rows[0];
      if (!isRecord(row)) {
        return undefined;
      }
      const projectId = row.projectId;
      const projectSlug = row.projectSlug;
      if (typeof projectId !== 'string' || typeof projectSlug !== 'string') {
        return undefined;
      }
      return { projectId, projectSlug };
    },
  };
}

function createRebuildIndexingRepository(
  sql: PostgresGraphExecutor,
  storage: ObjectStorage,
  resumeCursor?: string,
): GraphIndexingRepository {
  const rebuildRepository = createPostgresGraphRebuildIndexingRepository(sql, storage);
  return {
    findActorByAlias: (actorInput) => rebuildRepository.findActorByAlias(actorInput),
    findActorByGraphNodeId: (actorInput) => rebuildRepository.findActorByGraphNodeId(actorInput),
    findDocumentsBySourceIds: (documentInput) =>
      rebuildRepository.findDocumentsBySourceIds(documentInput),
    findSameAsDocuments: (sameAsInput) => rebuildRepository.findSameAsDocuments(sameAsInput),
    markFailed: async () => undefined,
    markIndexed: async () => undefined,
    readGraphTargets: (targetInput) =>
      rebuildRepository.readGraphTargets({
        ...targetInput,
        resumeCursor,
      }),
    replaceEmailQuotes: async () => undefined,
  };
}

function buildRebuildResult(input: {
  readonly collector: DryRunGraphMutationCollector;
  readonly decisions: Awaited<ReturnType<typeof storeGraphRelations>>['decisions'];
  readonly dryRun: boolean;
  readonly limit: number;
}): GraphRebuildResult {
  const failedCount = input.decisions.filter((decision) => decision.decision === 'failed').length;
  if (failedCount > 0) {
    return {
      dryRun: input.dryRun,
      duplicateAttemptCount: input.collector.duplicateAttemptCount,
      edgeCount: input.collector.edgeCount,
      failedCount,
      hasMore: true,
      nodeCount: input.collector.nodeCount,
      processedCount: input.decisions.length,
    };
  }
  const lastDecision = input.decisions.at(-1);
  return {
    dryRun: input.dryRun,
    duplicateAttemptCount: input.collector.duplicateAttemptCount,
    edgeCount: input.collector.edgeCount,
    failedCount,
    hasMore: input.decisions.length === input.limit,
    nextResumeCursor:
      lastDecision === undefined ? undefined : digestRawDocumentId(lastDecision.rawDocumentId),
    nodeCount: input.collector.nodeCount,
    processedCount: input.decisions.length,
  };
}

function wrapMutationRepository(
  delegate: GraphMutationRepository,
  collector: DryRunGraphMutationCollector,
): GraphMutationRepository {
  return {
    deleteDocumentGraphNodes: (cleanupInput) => delegate.deleteDocumentGraphNodes(cleanupInput),
    deleteProjectGraph: (projectInput) => delegate.deleteProjectGraph(projectInput),
    ensureProjectGraph: async (projectInput) => {
      await delegate.ensureProjectGraph(projectInput);
    },
    mergeActorGraphNodes: (mergeInput) => delegate.mergeActorGraphNodes(mergeInput),
    upsertEdge: async (edgeInput) => {
      await collector.upsertEdge(edgeInput);
      await delegate.upsertEdge(edgeInput);
    },
    upsertNode: async (nodeInput) => {
      await collector.upsertNode(nodeInput);
      await delegate.upsertNode(nodeInput);
    },
  };
}

class DryRunGraphMutationCollector implements GraphMutationRepository {
  private readonly edges = new Set<string>();
  private readonly nodes = new Set<string>();
  duplicateAttemptCount = 0;

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  async deleteDocumentGraphNodes(): Promise<number> {
    return 0;
  }

  async deleteProjectGraph(): Promise<void> {
    return undefined;
  }

  async ensureProjectGraph(): Promise<void> {
    return undefined;
  }

  async mergeActorGraphNodes(): Promise<{ reason: string; status: 'skipped' }> {
    return { reason: 'dry-run', status: 'skipped' };
  }

  async upsertEdge(input: {
    fromGraphNodeId: string;
    relationType: GraphRelationType;
    toGraphNodeId: string;
  }): Promise<void> {
    const endpoints =
      input.relationType === 'SAME_AS'
        ? canonicalizeSameAsEdgeEndpoints(input.fromGraphNodeId, input.toGraphNodeId)
        : { sourceNodeKey: input.fromGraphNodeId, targetNodeKey: input.toGraphNodeId };
    const key = `${endpoints.sourceNodeKey}\u001f${input.relationType}\u001f${endpoints.targetNodeKey}`;
    if (this.edges.has(key)) {
      this.duplicateAttemptCount += 1;
    }
    this.edges.add(key);
  }

  async upsertNode(input: { graphNodeId: string }): Promise<void> {
    if (this.nodes.has(input.graphNodeId)) {
      this.duplicateAttemptCount += 1;
    }
    this.nodes.add(input.graphNodeId);
  }
}

function digestRawDocumentId(rawDocumentId: string): string {
  return createHash('sha256').update(rawDocumentId, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
