import type postgres from 'postgres';
import {
  GRAPH_RELATED_DOCUMENT_POOL_LIMITS,
  type GraphPresetId,
  type GraphReadRepository,
  type GraphRelatedDocumentCandidate,
  type GraphRelationType,
  parseGraphCountResult,
  parseGraphPresetId,
  parseGraphPresetReadResult,
  parseGraphRelationTypes,
} from './index.js';
import {
  createReadUnavailableError,
  logRelationalReadUnavailable,
  parseGraphCountFromRows,
  parseRelationalCountRow,
  requireNonEmptyString,
  requireRecord,
} from './postgres-relational-common.js';
import {
  GRAPH_PRESET_MAX_EDGES,
  GRAPH_PRESET_MAX_NODES,
  normalizePresetRows,
  parseRelationalGraphReadRow,
  type RelationalGraphReadRow,
} from './postgres-relational-read-preset.js';
import {
  GRAPH_PRESET_QUERY_LIMIT,
  graphRelationQueryRowLimit,
  queryActorDocumentsPreset,
  queryRecentRelationsPreset,
  RELATED_DOCUMENT_QUERIES,
  selectRelatedDocumentCandidates,
  withReadOnlyTransaction,
} from './postgres-relational-read-sql.js';

export { deriveRelationalGraphNodeKindSubtype } from './postgres-relational-common.js';
export { parseRelationalGraphReadRow, type RelationalGraphReadRow };

const PRESET_DESCRIPTIONS: Readonly<Record<GraphPresetId, string>> = {
  'actor-documents':
    'actor-documents preset: bounded actor-to-document relations for eligible document graph nodes',
  'recent-relations':
    'recent-relations preset: bounded document neighborhood for eligible document graph nodes',
};

/** Returns a provider-neutral preset description retained by the Graph Viewer contract. */
export function relationalGraphPresetPreview(presetId: GraphPresetId): string {
  return PRESET_DESCRIPTIONS[presetId];
}

/**
 * Creates the PostgreSQL relational-table implementation of provider-neutral graph reads.
 *
 * @param sql - A postgres.js connection used for project-scoped read-only graph queries.
 */
export function createPostgresRelationalGraphReadRepository(
  sql: postgres.Sql,
): GraphReadRepository {
  return {
    async countDocumentNode(input) {
      requireProjectId(input.projectId);
      requireNonEmptyString(input.graphNodeId, 'graphNodeId');
      try {
        return await withReadOnlyTransaction(sql, async (transaction) => {
          const rows = (await transaction`
            SELECT count(*)::int AS count
            FROM public.graph_nodes
            WHERE project_id = ${input.projectId}::uuid
              AND node_key = ${input.graphNodeId}
              AND kind = 'document'
          `) as readonly unknown[];
          return parseGraphCountFromRows(rows, 'document node count');
        });
      } catch (error) {
        throwReadUnavailable('count_document_node', error);
      }
    },
    async countRelations(input) {
      requireProjectId(input.projectId);
      requireNonEmptyString(input.graphNodeId, 'graphNodeId');
      const relationTypes = parseGraphRelationTypes(input.relationTypes);
      if (relationTypes.length === 0) {
        return {};
      }
      try {
        return await withReadOnlyTransaction(sql, async (transaction) => {
          const rows = (await transaction`
            SELECT relation_type AS "relationType", count(*)::int AS count
            FROM public.graph_edges
            WHERE project_id = ${input.projectId}::uuid
              AND (
                source_node_key = ${input.graphNodeId}
                OR target_node_key = ${input.graphNodeId}
              )
              AND relation_type IN ${transaction(relationTypes)}
            GROUP BY relation_type
          `) as readonly unknown[];
          const counts: Partial<Record<GraphRelationType, number>> = {};
          for (const relationType of relationTypes) {
            counts[relationType] = 0;
          }
          for (const row of rows) {
            const parsed = parseRelationCountQueryRow(row, relationTypes);
            counts[parsed.relationType] = parseGraphCountResult(parsed.count);
          }
          return counts;
        });
      } catch (error) {
        throwReadUnavailable('count_relations', error);
      }
    },
    async findRelatedDocuments(input) {
      requireProjectId(input.projectId);
      const seedDocumentIds = [...new Set(input.seedDocumentIds)].slice(0, 10);
      if (seedDocumentIds.length === 0) {
        return { candidates: [], status: 'success' };
      }
      try {
        const relationLimits = { ...GRAPH_RELATED_DOCUMENT_POOL_LIMITS, ...input.relationLimits };
        const candidates = await withReadOnlyTransaction(sql, async (transaction) => {
          const collected: GraphRelatedDocumentCandidate[] = [];
          for (const query of RELATED_DOCUMENT_QUERIES) {
            const limit = graphRelationQueryRowLimit(
              relationLimits[query.relationType],
              seedDocumentIds.length,
            );
            const rows = (await transaction.unsafe(query.sql, [
              input.projectId,
              seedDocumentIds,
              limit,
            ])) as readonly unknown[];
            collected.push(
              ...selectRelatedDocumentCandidates({
                hopCount: query.hopCount,
                limit: relationLimits[query.relationType],
                relationType: query.relationType,
                rows,
              }),
            );
          }
          return collected;
        });
        return { candidates, status: 'success' };
      } catch (error) {
        logRelationalReadUnavailable('find_related_documents', error);
        return { candidates: [], status: 'unavailable' };
      }
    },
    async readPreset(input) {
      requireProjectId(input.projectId);
      const presetId = parseGraphPresetId(input.presetId);
      const preview = relationalGraphPresetPreview(presetId);
      const documentGraphNodeIds = [...new Set(input.documentGraphNodeIds)];
      if (documentGraphNodeIds.length === 0) {
        return parseGraphPresetReadResult({
          edges: [],
          nodes: [],
          preview,
          rawRows: [],
          rowCount: 0,
          truncated: false,
        });
      }
      try {
        const rows = await withReadOnlyTransaction(sql, async (transaction) =>
          presetId === 'actor-documents'
            ? queryActorDocumentsPreset(transaction, input.projectId, documentGraphNodeIds)
            : queryRecentRelationsPreset(transaction, input.projectId, documentGraphNodeIds),
        );
        const normalized = normalizePresetRows(rows, {
          maxEdges: GRAPH_PRESET_MAX_EDGES,
          maxNodes: GRAPH_PRESET_MAX_NODES,
          queryLimit: GRAPH_PRESET_QUERY_LIMIT,
        });
        return parseGraphPresetReadResult({
          ...normalized.result,
          preview,
          rawRows: normalized.rawRows,
          rowCount: normalized.rawRows.length,
        });
      } catch (error) {
        throwReadUnavailable('read_preset', error);
      }
    },
  };
}

function requireProjectId(projectId: string): void {
  requireNonEmptyString(projectId, 'projectId');
}

function throwReadUnavailable(operation: string, error: unknown): never {
  logRelationalReadUnavailable(operation, error);
  throw createReadUnavailableError();
}

function parseRelationCountQueryRow(
  row: unknown,
  allowedRelationTypes: readonly GraphRelationType[],
): { readonly count: number; readonly relationType: GraphRelationType } {
  const record = requireRecord(row, 'relation count row');
  const relationType = record.relationType;
  if (
    typeof relationType !== 'string' ||
    !(allowedRelationTypes as readonly string[]).includes(relationType)
  ) {
    throw new Error('Invalid relational relation count row: relationType is not allowlisted.');
  }
  return {
    count: parseRelationalCountRow(record, 'relation count'),
    relationType: relationType as GraphRelationType,
  };
}
