import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { collectGraphParity, parseGraphState } from '../../scripts/lib/parity-graph.ts';
import { buildWorker } from './build.mjs';

/** Runs shared Graph inputs through the existing real D1/workerd harness with egress denied.
 * Direct DB access is used only for schema setup and full persisted-state observation.
 */
export async function collectD1GraphParity() {
  const { script } = await buildWorker('d1-worker');
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'parity-graph' },
    outboundService: () => new Response(null, { status: 403 }),
  });
  try {
    await runtime.ready;
    const db = await runtime.getD1Database('DB');
    const schema = await readFile(new URL('d1/0001_graph.sql', import.meta.url), 'utf8');
    await db.batch(
      schema
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    await db.prepare("INSERT INTO projects VALUES ('alpha'), ('beta')").run();
    const call = async (operation, input) => {
      const response = await runtime.dispatchFetch('http://local.test/graph', {
        method: 'POST',
        body: JSON.stringify({ operation, input }),
      });
      if (response.status !== 200) throw new Error(`Local graph ${operation} failed`);
      return (await response.json()).result;
    };
    return await collectGraphParity({
      mutation: Object.fromEntries(
        [
          'ensureProjectGraph',
          'deleteProjectGraph',
          'upsertNode',
          'upsertEdge',
          'mergeActorGraphNodes',
          'deleteDocumentGraphNodes',
        ].map((method) => [method, (input) => call(method, input)]),
      ),
      read: { findRelatedDocuments: (input) => call('findRelatedDocuments', input) },
      async snapshot(projectId) {
        const nodes = await db
          .prepare('SELECT * FROM graph_nodes WHERE project_id=?')
          .bind(projectId)
          .all();
        const edges = await db
          .prepare('SELECT * FROM graph_edges WHERE project_id=?')
          .bind(projectId)
          .all();
        return parseGraphState(nodes.results, edges.results);
      },
    });
  } finally {
    await runtime.dispose();
  }
}
