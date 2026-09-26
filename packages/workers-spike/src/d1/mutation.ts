import {
  type GraphMutationRepository,
  parseGraphActorMergeInput,
  parseGraphDocumentCleanupInput,
  parseGraphMutationEdgeInput,
  parseGraphMutationNodeInput,
  parseGraphProjectMutationInput,
} from '@pufu-lens/graph';
import { type D1Binding, ids, record, rows, text } from './binding.js';

// json_patch uses recursive merge and deletes nulls: use json_each/group_object for
// PostgreSQL JSONB || semantics (shallow replacement, including explicit JSON null).
const MERGE_PROPERTIES = `(SELECT json_group_object(key,json(value)) FROM (
  SELECT key, CASE type WHEN 'text' THEN json_quote(value) WHEN 'null' THEN 'null'
    WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE value END AS value
  FROM json_each(graph_nodes.properties) WHERE key NOT IN (SELECT key FROM json_each(excluded.properties))
  UNION ALL
  SELECT key, CASE type WHEN 'text' THEN json_quote(value) WHEN 'null' THEN 'null'
    WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE value END FROM json_each(excluded.properties)
))`;

/** Creates project-scoped D1 mutations. Actor merge is one atomic batch; no read/write gap. */
export function createD1GraphMutationRepository(db: D1Binding): GraphMutationRepository {
  async function execute(sql: string, ...values: (string | number | null)[]) {
    return rows(
      await db
        .prepare(sql)
        .bind(...values)
        .all(),
    );
  }
  async function requireProject(projectId: string) {
    const result = await execute('SELECT id FROM projects WHERE id=?', projectId);
    if (result.length !== 1 || record(result[0]).id !== projectId)
      throw new Error('Graph mutation capability unavailable.');
  }
  return {
    async ensureProjectGraph(input) {
      await requireProject(parseGraphProjectMutationInput(input).projectId);
    },
    async deleteProjectGraph(input) {
      const { projectId } = parseGraphProjectMutationInput(input);
      await requireProject(projectId);
      await execute('DELETE FROM graph_nodes WHERE project_id=?', projectId);
    },
    async deleteDocumentGraphNodes(input) {
      const p = parseGraphDocumentCleanupInput(input);
      const deleted = await execute(
        "DELETE FROM graph_nodes WHERE project_id=? AND kind='document' AND node_key IN (SELECT value FROM json_each(?)) RETURNING node_key",
        p.projectId,
        ids(p.graphNodeIds),
      );
      for (const row of deleted) text(record(row).node_key);
      return deleted.length;
    },
    async upsertNode(input) {
      const p = parseGraphMutationNodeInput(input);
      const label = p.labels[0];
      if (!['Actor', 'Document', 'Topic'].includes(label ?? ''))
        throw new Error('Invalid graph label');
      const kind = label?.toLowerCase();
      const subtype =
        kind === 'document'
          ? text(p.properties.docType)
          : kind === 'topic'
            ? text(p.properties.topicType)
            : text(p.properties.actorType ?? 'person');
      await execute(
        `INSERT INTO graph_nodes(project_id,node_key,kind,subtype,properties) VALUES(?,?,?,?,?)
        ON CONFLICT(project_id,node_key) DO UPDATE SET kind=excluded.kind,subtype=excluded.subtype,properties=${MERGE_PROPERTIES}`,
        p.projectId,
        p.graphNodeId,
        text(kind),
        subtype,
        JSON.stringify({ ...p.properties, graphNodeId: p.graphNodeId, graphLabels: p.labels }),
      );
    },
    async upsertEdge(input) {
      const p = parseGraphMutationEdgeInput(input);
      if (p.relationType === 'SAME_AS' && p.fromGraphNodeId === p.toGraphNodeId)
        throw new Error('SAME_AS endpoints must differ.');
      // SQLite BINARY compares UTF-8 bytes, including non-BMP keys.
      await execute(
        `INSERT INTO graph_edges(project_id,source_node_key,target_node_key,relation_type,properties)
        VALUES(?1,CASE WHEN ?4='SAME_AS' THEN min(?2,?3) ELSE ?2 END,
        CASE WHEN ?4='SAME_AS' THEN max(?2,?3) ELSE ?3 END,?4,?5)
        ON CONFLICT(project_id,source_node_key,target_node_key,relation_type) DO UPDATE SET properties=excluded.properties`,
        p.projectId,
        p.fromGraphNodeId,
        p.toGraphNodeId,
        p.relationType,
        JSON.stringify(p.properties),
      );
    },
    async mergeActorGraphNodes(input) {
      const p = parseGraphActorMergeInput(input);
      if (p.primaryGraphNodeId === p.secondaryGraphNodeId)
        return { status: 'skipped', reason: 'primary and secondary graph nodes are identical' };
      // Guard and all mutations run in the same batch snapshot. json('invalid') is
      // evaluated only if a secondary Actor exists without a primary Actor.
      const values = [p.projectId, p.primaryGraphNodeId, p.secondaryGraphNodeId, p.primaryActorId];
      const statement = (sql: string) => db.prepare(sql).bind(...values);
      const secondary =
        "EXISTS(SELECT 1 FROM graph_nodes WHERE project_id=?1 AND node_key=?3 AND kind='actor')";
      try {
        const results = await db.batch([
          statement(
            `SELECT CASE WHEN ${secondary} AND NOT EXISTS(SELECT 1 FROM graph_nodes WHERE project_id=?1 AND node_key=?2 AND kind='actor') THEN json('invalid') ELSE ?4 END AS guard`,
          ),
          statement(`INSERT INTO graph_edges(project_id,source_node_key,target_node_key,relation_type,properties)
            SELECT project_id, CASE WHEN relation_type='SAME_AS' THEN min(s,t) ELSE s END,
              CASE WHEN relation_type='SAME_AS' THEN max(s,t) ELSE t END,relation_type,json_set(properties,'$.actorId',?4)
            FROM (SELECT *,CASE WHEN source_node_key=?3 THEN ?2 ELSE source_node_key END s,
              CASE WHEN target_node_key=?3 THEN ?2 ELSE target_node_key END t FROM graph_edges
              WHERE project_id=?1 AND (source_node_key=?3 OR target_node_key=?3) AND ${secondary})
            WHERE s<>t
            ON CONFLICT(project_id,source_node_key,target_node_key,relation_type) DO NOTHING`),
          statement(
            `DELETE FROM graph_nodes WHERE project_id=?1 AND node_key=?3 AND kind='actor' AND ?2<>?3 AND ?4 IS NOT NULL RETURNING node_key`,
          ),
        ]);
        for (const result of results) rows(result);
        const deleted = rows(results[2] ?? { success: false, results: [] });
        for (const row of deleted) text(record(row).node_key);
        return deleted.length
          ? { status: 'merged', deletedCount: deleted.length }
          : { status: 'skipped', reason: 'secondary actor graph node not found' };
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
