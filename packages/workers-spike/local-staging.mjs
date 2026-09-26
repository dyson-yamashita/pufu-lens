import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { buildWorker } from './build.mjs';

export const localToken = 'local-synthetic-token-not-a-secret-792';
/** Supplies explicit expiring local-only configuration without reading environment credentials. */
export const stagingBindings = () => ({
  PUFU_LENS_DATA_PROFILE: 'cloudflare',
  STAGE: 'synthetic-staging',
  FIXTURE_VERSION: 'cloudflare-composition-v1',
  SCHEMA_VERSION: '0004_composition',
  EMBEDDING_MODEL: 'synthetic-v1',
  EMBEDDING_DIMENSIONS: '1536',
  INDEXED_METADATA: 'projectId,model',
  EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
  EVAL_TOKEN: localToken,
});

/** Creates disposable local D1/workerd and an explicit in-memory Vectorize fake.
 * Outbound networking is denied except the intercepted fake hostname; no credentials are read.
 */
export async function localStaging({ bindings = {}, migrate = true, nativeEntry = false } = {}) {
  const vectors = new Map();
  const calls = [];
  const state = {
    failure: null,
    description: { dimensions: 1536, metric: 'cosine' },
    override: null,
    afterQuery: null,
  };
  const { script } = await buildWorker(nativeEntry ? 'staging-worker' : 'staging-local-worker');
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'composition-local' },
    bindings: { ...stagingBindings(), ...bindings },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'vectorize-fake.invalid') throw new Error('Outbound denied');
      const method = url.pathname.slice(1);
      const body = await request.json();
      calls.push({ method, body });
      if (method === state.failure) return new Response(null, { status: 503 });
      if (method === 'describe') return Response.json(state.description);
      if (method === 'upsert') for (const vector of body) vectors.set(vector.id, vector);
      if (method === 'delete') for (const id of body) vectors.delete(id);
      if (method === 'query') {
        const { values, options } = body;
        const norm = (v) => Math.sqrt(v.reduce((sum, n) => sum + n * n, 0));
        const matches =
          state.override ??
          [...vectors.values()]
            .filter(
              (v) =>
                v.namespace === options.namespace &&
                v.metadata.projectId === options.filter.projectId &&
                v.metadata.model === options.filter.model,
            )
            .map((v) => ({
              id: v.id,
              namespace: v.namespace,
              metadata: v.metadata,
              score: Math.min(
                1,
                v.values.reduce((sum, n, i) => sum + n * values[i], 0) /
                  (norm(values) * norm(v.values)),
              ),
            }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .slice(0, options.topK);
        if (state.afterQuery) {
          const callback = state.afterQuery;
          state.afterQuery = null;
          await callback();
        }
        return Response.json({ count: matches.length, matches });
      }
      return Response.json({ mutationId: `fake-${calls.length}` });
    },
  });
  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  if (migrate)
    for (const file of [
      '0001_graph.sql',
      '0002_keyword.sql',
      '0003_semantic.sql',
      '0004_composition.sql',
    ]) {
      const sql = await readFile(new URL(`d1/${file}`, import.meta.url), 'utf8');
      await db.batch(
        sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
  const call = async (
    operation,
    { projectId = 'fixture-alpha', document = 0, revision = 1, ...extra } = {},
    token = localToken,
  ) => {
    const response = await runtime.dispatchFetch('http://local.test/evaluate', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, projectId, document, revision, ...extra }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, db, vectors, calls, state, call };
}
