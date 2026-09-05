import type postgres from 'postgres';
import {
  type GraphActorMergeInput,
  type GraphActorMergeResult,
  type GraphMutationEdgeInput,
  type GraphMutationNodeInput,
  type GraphMutationRepository,
  parseGraphActorMergeInput,
  parseGraphDocumentCleanupInput,
  parseGraphMutationEdgeInput,
  parseGraphMutationNodeInput,
  parseGraphProjectMutationInput,
} from './index.js';
import {
  bindSafeJsonParameter,
  compareUtf8ByteOrder,
  createMutationUnavailableError,
  deriveRelationalGraphNodeKindSubtype,
  isMutationUnavailableError,
  isRecord,
  logRelationalMutationUnavailable,
  parseRelationalIntegerField,
  requireNonEmptyString,
} from './postgres-relational-common.js';

type RelationalExecutor = postgres.Sql | postgres.TransactionSql;

class ActorMergeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActorMergeInvariantError';
  }
}

/** Canonicalizes SAME_AS endpoints into a UTF-8 byte-order source/target pair. */
export function canonicalizeSameAsEdgeEndpoints(
  fromGraphNodeId: string,
  toGraphNodeId: string,
): { readonly sourceNodeKey: string; readonly targetNodeKey: string } {
  const from = requireNonEmptyString(fromGraphNodeId, 'fromGraphNodeId');
  const to = requireNonEmptyString(toGraphNodeId, 'toGraphNodeId');
  if (from === to) {
    throw new Error('SAME_AS endpoints must differ.');
  }
  return compareUtf8ByteOrder(from, to) <= 0
    ? { sourceNodeKey: from, targetNodeKey: to }
    : { sourceNodeKey: to, targetNodeKey: from };
}

export { deriveRelationalGraphNodeKindSubtype } from './postgres-relational-common.js';

/** Parses a relational mutation count row returned by scoped SQL mutations. */
export function parseRelationalGraphMutationCountRow(row: unknown, label: string): number {
  if (!isRecord(row)) {
    throw new Error(`Invalid relational ${label}.`);
  }
  return parseRelationalIntegerField(row.count, label);
}

/**
 * Creates the PostgreSQL relational-table implementation of provider-neutral graph mutations.
 *
 * @param sql - A postgres.js connection or caller-owned transaction executor scoped to one project mutation.
 */
export function createPostgresRelationalGraphMutationRepository(
  sql: RelationalExecutor,
): GraphMutationRepository {
  return {
    async deleteDocumentGraphNodes(input) {
      const parsed = parseGraphDocumentCleanupInput(input);
      try {
        const rows = (await sql`
          DELETE FROM public.graph_nodes
          WHERE project_id = ${parsed.projectId}::uuid
            AND kind = 'document'
            AND node_key IN ${sql(parsed.graphNodeIds)}
          RETURNING node_key
        `) as readonly unknown[];
        return rows.length;
      } catch (error) {
        rethrowOrNormalizeMutationError('delete_document_graph_nodes', error);
      }
    },
    async deleteProjectGraph(input) {
      const parsed = parseGraphProjectMutationInput(input);
      try {
        await requireExistingProject(sql, parsed.projectId);
        await sql`
          DELETE FROM public.graph_nodes
          WHERE project_id = ${parsed.projectId}::uuid
        `;
      } catch (error) {
        rethrowOrNormalizeMutationError('delete_project_graph', error);
      }
    },
    async ensureProjectGraph(input) {
      const parsed = parseGraphProjectMutationInput(input);
      try {
        await requireExistingProject(sql, parsed.projectId);
      } catch (error) {
        rethrowOrNormalizeMutationError('ensure_project_graph', error);
      }
    },
    async mergeActorGraphNodes(input) {
      const parsed = parseGraphActorMergeInput(input);
      if (parsed.primaryGraphNodeId === parsed.secondaryGraphNodeId) {
        return {
          reason: 'primary and secondary graph nodes are identical',
          status: 'skipped',
        };
      }
      if (isSql(sql)) {
        try {
          return await sql.begin(async (transaction) =>
            mergeActorGraphNodesInRelational(transaction, parsed),
          );
        } catch (error) {
          if (error instanceof ActorMergeInvariantError) {
            throw error;
          }
          logRelationalMutationUnavailable('merge_actor_graph_nodes', error);
          return { status: 'unavailable' };
        }
      }
      return await mergeActorGraphNodesInRelational(sql, parsed);
    },
    async upsertEdge(input) {
      const parsed = parseGraphMutationEdgeInput(input);
      try {
        await upsertRelationalEdge(sql, parsed);
      } catch (error) {
        rethrowOrNormalizeMutationError('upsert_edge', error);
      }
    },
    async upsertNode(input) {
      const parsed = parseGraphMutationNodeInput(input);
      try {
        await upsertRelationalNode(sql, parsed);
      } catch (error) {
        rethrowOrNormalizeMutationError('upsert_node', error);
      }
    },
  };
}

async function mergeActorGraphNodesInRelational(
  sql: RelationalExecutor,
  input: GraphActorMergeInput,
): Promise<GraphActorMergeResult> {
  const secondaryCount = await countActorNode(sql, input.projectId, input.secondaryGraphNodeId);
  if (secondaryCount === 0) {
    return { reason: 'secondary actor graph node not found', status: 'skipped' };
  }
  if (secondaryCount !== 1) {
    throw new ActorMergeInvariantError(
      `expected 1 secondary actor graph node, found ${secondaryCount}`,
    );
  }
  const primaryCount = await countActorNode(sql, input.projectId, input.primaryGraphNodeId);
  if (primaryCount !== 1) {
    throw new ActorMergeInvariantError(
      `expected 1 primary actor graph node, found ${primaryCount}`,
    );
  }

  const primaryActorProperties = bindSafeJsonParameter(
    sql,
    { actorId: input.primaryActorId },
    'actor merge properties',
  );

  await sql`
    INSERT INTO public.graph_edges (
      project_id, source_node_key, target_node_key, relation_type, properties
    )
    SELECT
      project_id,
      CASE
        WHEN relation_type = 'SAME_AS' THEN
          CASE
            WHEN (${input.primaryGraphNodeId})::text COLLATE "C" <= target_node_key::text COLLATE "C"
            THEN ${input.primaryGraphNodeId}
            ELSE target_node_key
          END
        ELSE ${input.primaryGraphNodeId}
      END,
      CASE
        WHEN relation_type = 'SAME_AS' THEN
          CASE
            WHEN (${input.primaryGraphNodeId})::text COLLATE "C" <= target_node_key::text COLLATE "C"
            THEN target_node_key
            ELSE ${input.primaryGraphNodeId}
          END
        ELSE target_node_key
      END,
      relation_type,
      properties || ${primaryActorProperties}
    FROM public.graph_edges
    WHERE project_id = ${input.projectId}::uuid
      AND source_node_key = ${input.secondaryGraphNodeId}
      AND (
        relation_type <> 'SAME_AS' AND target_node_key <> ${input.primaryGraphNodeId}
        OR (
          relation_type = 'SAME_AS'
          AND (
            CASE
              WHEN (${input.primaryGraphNodeId})::text COLLATE "C" <= target_node_key::text COLLATE "C"
              THEN (${input.primaryGraphNodeId})::text COLLATE "C"
              ELSE target_node_key::text COLLATE "C"
            END
            <>
            CASE
              WHEN (${input.primaryGraphNodeId})::text COLLATE "C" <= target_node_key::text COLLATE "C"
              THEN target_node_key::text COLLATE "C"
              ELSE (${input.primaryGraphNodeId})::text COLLATE "C"
            END
          )
        )
      )
    ON CONFLICT (project_id, source_node_key, target_node_key, relation_type) DO NOTHING
  `;
  await sql`
    INSERT INTO public.graph_edges (
      project_id, source_node_key, target_node_key, relation_type, properties
    )
    SELECT
      project_id,
      CASE
        WHEN relation_type = 'SAME_AS' THEN
          CASE
            WHEN source_node_key::text COLLATE "C" <= (${input.primaryGraphNodeId})::text COLLATE "C"
            THEN source_node_key
            ELSE ${input.primaryGraphNodeId}
          END
        ELSE source_node_key
      END,
      CASE
        WHEN relation_type = 'SAME_AS' THEN
          CASE
            WHEN source_node_key::text COLLATE "C" <= (${input.primaryGraphNodeId})::text COLLATE "C"
            THEN ${input.primaryGraphNodeId}
            ELSE source_node_key
          END
        ELSE ${input.primaryGraphNodeId}
      END,
      relation_type,
      properties || ${primaryActorProperties}
    FROM public.graph_edges
    WHERE project_id = ${input.projectId}::uuid
      AND target_node_key = ${input.secondaryGraphNodeId}
      AND (
        relation_type <> 'SAME_AS' AND source_node_key <> ${input.primaryGraphNodeId}
        OR (
          relation_type = 'SAME_AS'
          AND (
            CASE
              WHEN source_node_key::text COLLATE "C" <= (${input.primaryGraphNodeId})::text COLLATE "C"
              THEN source_node_key::text COLLATE "C"
              ELSE (${input.primaryGraphNodeId})::text COLLATE "C"
            END
            <>
            CASE
              WHEN source_node_key::text COLLATE "C" <= (${input.primaryGraphNodeId})::text COLLATE "C"
              THEN (${input.primaryGraphNodeId})::text COLLATE "C"
              ELSE source_node_key::text COLLATE "C"
            END
          )
        )
      )
    ON CONFLICT (project_id, source_node_key, target_node_key, relation_type) DO NOTHING
  `;

  await sql`
    DELETE FROM public.graph_edges
    WHERE project_id = ${input.projectId}::uuid
      AND (
        source_node_key = ${input.secondaryGraphNodeId}
        OR target_node_key = ${input.secondaryGraphNodeId}
      )
  `;

  const deleteRows = (await sql`
    DELETE FROM public.graph_nodes
    WHERE project_id = ${input.projectId}::uuid
      AND node_key = ${input.secondaryGraphNodeId}
      AND kind = 'actor'
    RETURNING node_key
  `) as readonly unknown[];
  const deletedCount = deleteRows.length;
  if (deletedCount !== 1) {
    throw new ActorMergeInvariantError(
      `Actor graph reconcile failed: expected to delete 1 secondary node, deleted ${deletedCount}.`,
    );
  }
  return { deletedCount, status: 'merged' };
}

async function upsertRelationalNode(
  sql: RelationalExecutor,
  input: GraphMutationNodeInput,
): Promise<void> {
  const mapped = deriveRelationalGraphNodeKindSubtype({
    labels: input.labels,
    properties: {
      ...input.properties,
      graphNodeId: input.graphNodeId,
      graphLabels: input.labels,
    },
  });
  const propertiesJson = bindSafeJsonParameter(
    sql,
    mapped.normalizedProperties,
    'graph mutation node properties',
  );
  await sql`
    INSERT INTO public.graph_nodes (project_id, node_key, kind, subtype, properties)
    VALUES (
      ${input.projectId}::uuid,
      ${input.graphNodeId},
      ${mapped.kind},
      ${mapped.subtype},
      ${propertiesJson}
    )
    ON CONFLICT (project_id, node_key) DO UPDATE SET
      kind = EXCLUDED.kind,
      subtype = EXCLUDED.subtype,
      properties = public.graph_nodes.properties || EXCLUDED.properties,
      updated_at = now()
  `;
}

async function upsertRelationalEdge(
  sql: RelationalExecutor,
  input: GraphMutationEdgeInput,
): Promise<void> {
  const endpoints =
    input.relationType === 'SAME_AS'
      ? canonicalizeSameAsEdgeEndpoints(input.fromGraphNodeId, input.toGraphNodeId)
      : {
          sourceNodeKey: input.fromGraphNodeId,
          targetNodeKey: input.toGraphNodeId,
        };
  const propertiesJson = bindSafeJsonParameter(
    sql,
    input.properties,
    'graph mutation edge properties',
  );
  await sql`
    INSERT INTO public.graph_edges (
      project_id, source_node_key, target_node_key, relation_type, properties
    )
    VALUES (
      ${input.projectId}::uuid,
      ${endpoints.sourceNodeKey},
      ${endpoints.targetNodeKey},
      ${input.relationType},
      ${propertiesJson}
    )
    ON CONFLICT (project_id, source_node_key, target_node_key, relation_type) DO UPDATE SET
      properties = EXCLUDED.properties,
      updated_at = now()
  `;
}

async function requireExistingProject(sql: RelationalExecutor, projectId: string): Promise<void> {
  const rows = (await sql`
    SELECT id
    FROM public.projects
    WHERE id = ${projectId}::uuid
    LIMIT 1
  `) as readonly unknown[];
  if (rows.length !== 1 || !matchesExistingProjectLookupRow(rows[0], projectId)) {
    throw createMutationUnavailableError();
  }
}

function matchesExistingProjectLookupRow(row: unknown, expectedProjectId: string): boolean {
  if (!isRecord(row)) {
    return false;
  }
  const id = row.id;
  return typeof id === 'string' && id.trim().length > 0 && id === expectedProjectId;
}

async function countActorNode(
  sql: RelationalExecutor,
  projectId: string,
  nodeKey: string,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_nodes
    WHERE project_id = ${projectId}::uuid
      AND node_key = ${nodeKey}
      AND kind = 'actor'
  `) as readonly unknown[];
  if (rows.length !== 1 || !isRecord(rows[0])) {
    throw createMutationUnavailableError();
  }
  return parseRelationalGraphMutationCountRow(rows[0], 'actor node count');
}

function rethrowOrNormalizeMutationError(operation: string, error: unknown): never {
  if (error instanceof Error && /^Invalid graph/.test(error.message)) {
    throw error;
  }
  if (error instanceof Error && error.message === 'SAME_AS endpoints must differ.') {
    throw error;
  }
  if (isMutationUnavailableError(error)) {
    logRelationalMutationUnavailable(operation, error);
    throw error;
  }
  if (isForeignKeyViolation(error)) {
    logRelationalMutationUnavailable(operation, error);
    throw createMutationUnavailableError();
  }
  logRelationalMutationUnavailable(operation, error);
  throw createMutationUnavailableError();
}

function isForeignKeyViolation(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const code = error.code;
  return code === '23503';
}

function isSql(value: RelationalExecutor): value is postgres.Sql {
  return typeof (value as postgres.Sql).begin === 'function';
}
