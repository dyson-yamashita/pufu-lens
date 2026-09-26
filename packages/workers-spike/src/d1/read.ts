import {
  GRAPH_RELATED_DOCUMENT_POOL_LIMITS,
  type GraphReadRepository,
  type GraphRelatedDocumentCandidate,
  type GraphRelatedRelationType,
  parseGraphCountResult,
  parseGraphPresetId,
  parseGraphRelatedDocumentCandidate,
  parseGraphRelationTypes,
} from '@pufu-lens/graph';
import { type D1Binding, type D1Result, ids, record, rows, text } from './binding.js';
import { readD1Preset } from './viewer.js';

const SEEDS = `seed.project_id=?1 AND seed.kind='document'
  AND json_extract(seed.properties,'$.documentId') IN (SELECT value FROM json_each(?2))
  AND json_extract(related.properties,'$.documentId') NOT IN (SELECT value FROM json_each(?2))`;
const SELECT = `SELECT json_extract(seed.properties,'$.documentId') AS seedDocumentId,
  json_extract(related.properties,'$.documentId') AS documentId`;
const ORDER_LIMIT = 'ORDER BY seedDocumentId,documentId LIMIT ?3';

function relatedSql(relation: GraphRelatedRelationType): string {
  if (relation === 'MENTIONS')
    return `${SELECT} FROM graph_nodes seed
    JOIN graph_edges e ON e.project_id=seed.project_id AND e.relation_type='MENTIONS'
      AND (e.source_node_key=seed.node_key OR e.target_node_key=seed.node_key)
    JOIN graph_nodes topic ON topic.project_id=e.project_id AND topic.kind='topic'
      AND topic.node_key=CASE WHEN e.source_node_key=seed.node_key THEN e.target_node_key ELSE e.source_node_key END
    JOIN graph_edges e2 ON e2.project_id=topic.project_id AND e2.relation_type='MENTIONS'
      AND (e2.source_node_key=topic.node_key OR e2.target_node_key=topic.node_key)
    JOIN graph_nodes related ON related.project_id=e2.project_id AND related.kind='document'
      AND related.node_key=CASE WHEN e2.source_node_key=topic.node_key THEN e2.target_node_key ELSE e2.source_node_key END
    WHERE ${SEEDS} ${ORDER_LIMIT}`;
  return `${SELECT} FROM graph_nodes seed
    JOIN graph_edges e ON e.project_id=seed.project_id AND e.relation_type='${relation}'
      AND (e.source_node_key=seed.node_key OR e.target_node_key=seed.node_key)
    JOIN graph_nodes related ON related.project_id=e.project_id AND related.kind='document'
      AND related.node_key=CASE WHEN e.source_node_key=seed.node_key THEN e.target_node_key ELSE e.source_node_key END
    WHERE ${SEEDS} ${ORDER_LIMIT}`;
}

/** Creates bounded D1 reads. Binding reads use primary routing (no replica session). */
export function createD1GraphReadRepository(db: D1Binding): GraphReadRepository {
  return {
    async countDocumentNode(input) {
      text(input.projectId);
      text(input.graphNodeId);
      const result = rows(
        await db
          .prepare(
            "SELECT count(*) AS count FROM graph_nodes WHERE project_id=? AND node_key=? AND kind='document'",
          )
          .bind(input.projectId, input.graphNodeId)
          .all(),
      );
      if (result.length !== 1) throw new Error('Invalid D1 count rows');
      return parseGraphCountResult(record(result[0]).count);
    },
    async countRelations(input) {
      text(input.projectId);
      text(input.graphNodeId);
      const types = parseGraphRelationTypes(input.relationTypes);
      if (types.length === 0) return {};
      const result = rows(
        await db
          .prepare(`SELECT relation_type,count(*) AS count FROM graph_edges
        WHERE project_id=?1 AND (source_node_key=?2 OR target_node_key=?2)
        AND relation_type IN (SELECT value FROM json_each(?3)) GROUP BY relation_type`)
          .bind(input.projectId, input.graphNodeId, ids(types))
          .all(),
      );
      const counts: Partial<Record<(typeof types)[number], number>> = {};
      for (const type of types) counts[type] = 0;
      for (const row of result) {
        const r = record(row);
        const type = parseGraphRelationTypes([r.relation_type])[0];
        if (!type || !types.includes(type)) throw new Error('Invalid D1 relation');
        counts[type] = parseGraphCountResult(r.count);
      }
      return counts;
    },
    async findRelatedDocuments(input) {
      text(input.projectId);
      ids(input.seedDocumentIds);
      for (const [relation, limit] of Object.entries(input.relationLimits ?? {})) {
        if (
          !Object.hasOwn(GRAPH_RELATED_DOCUMENT_POOL_LIMITS, relation) ||
          !Number.isSafeInteger(limit) ||
          limit < 0
        )
          throw new Error('Invalid graph relation limit');
      }
      const seeds = [...new Set(input.seedDocumentIds)].slice(0, 10);
      if (!seeds.length) return { status: 'success', candidates: [] };
      const limits = { ...GRAPH_RELATED_DOCUMENT_POOL_LIMITS, ...input.relationLimits };
      const relations = ['SAME_AS', 'RELATED_TO', 'MENTIONS'] as const;
      let results: D1Result[];
      try {
        results = await db.batch(
          relations.map((relation) =>
            db
              .prepare(relatedSql(relation))
              .bind(
                input.projectId,
                ids(seeds),
                Math.min(Math.max(1, limits[relation]) * seeds.length, 50),
              ),
          ),
        );
      } catch {
        return { status: 'unavailable', candidates: [] };
      }
      // Malformed rows are contract failures, not an empty or unavailable result.
      const candidates: GraphRelatedDocumentCandidate[] = [];
      for (const [i, relation] of relations.entries()) {
        const result = results[i];
        if (!result) throw new Error('Invalid D1 batch result');
        const seen = new Set<string>();
        for (const row of rows(result)) {
          const r = record(row);
          const parsed = parseGraphRelatedDocumentCandidate({
            documentId: r.documentId,
            seedDocumentId: r.seedDocumentId,
            relationType: relation,
            hopCount: relation === 'MENTIONS' ? 2 : 1,
          });
          if (seen.size >= limits[relation] || seen.has(parsed.documentId)) continue;
          seen.add(parsed.documentId);
          candidates.push(parsed);
        }
      }
      return { status: 'success', candidates };
    },
    async readPreset(input) {
      text(input.projectId);
      return readD1Preset(db, { ...input, presetId: parseGraphPresetId(input.presetId) });
    },
  };
}
