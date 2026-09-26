import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { localStaging } from './local-staging.mjs';

/** Exercises a fixed synthetic lifecycle through the authenticated entrypoint.
 * This runner is local-only; reports contain aggregate outcomes, IDs and versions, never credentials/content.
 * Synthetic nearest-neighbour results are contract checks, not semantic quality or Step 7 parity.
 */
export async function runStagingFixture(call) {
  let requests = 0;
  const latencies = [];
  const invoke = async (operation, input) => {
    if (++requests > 150) throw new Error('Fixture request budget exceeded');
    const start = performance.now();
    const { status, body } = await call(operation, input);
    latencies.push(performance.now() - start);
    assert.equal(status, 200, `${operation} failed`);
    assert.equal(body.fixture, 'cloudflare-composition-v1');
    return body.result;
  };
  for (const projectId of ['fixture-alpha', 'fixture-beta']) {
    for (let document = 0; document < 4; document++) await invoke('seed', { projectId, document });
    await invoke('graph', { projectId });
    assert.equal((await invoke('dispatch', { projectId })).length, 4);
    for (let document = 0; document < 4; document++) {
      const result = await invoke('query', { projectId, document });
      assert.equal(result.semantic[0], `doc-${document}`);
      assert.deepEqual(result.keyword, [`doc-${document}`]);
      assert.equal(result.hybrid[0], `doc-${document}`);
      if (document === 0) assert.equal(result.graph[0].documentId, 'doc-1');
    }
    await invoke('seed', { projectId, revision: 2 });
    await invoke('seed', { projectId, revision: 1 }); // reverse delivery must not roll back text
    await invoke('dispatch', { projectId });
    await invoke('repair', { projectId, revision: 1 });
    await invoke('repair', { projectId, revision: 2 });
    await invoke('dispatch', { projectId });
    assert.equal((await invoke('query', { projectId })).hybrid[0], 'doc-0');
    await invoke('seed', { projectId, revision: 3 });
    await invoke('dispatch', { projectId });
    const deleted = await invoke('query', { projectId });
    assert.deepEqual(deleted.keyword, []);
    assert.ok(!deleted.semantic.includes('doc-0'));
    assert.ok(!deleted.hybrid.includes('doc-0'));
  }
  latencies.sort((a, b) => a - b);
  return {
    fixture: 'cloudflare-composition-v1',
    schema: '0004_composition',
    model: 'synthetic-v1',
    dimensions: 1536,
    runtime: 'workerd-local',
    vectorize: 'fake',
    requests,
    projects: 2,
    documents: 8,
    p50Ms: latencies[Math.floor(latencies.length * 0.5)],
    p95Ms: latencies[Math.floor(latencies.length * 0.95)],
    remoteGate: 'not-run',
    parityGate: 'not-run',
    outcome: 'passed',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Local fixture takes no options');
  const local = await localStaging();
  try {
    console.log(JSON.stringify(await runStagingFixture(local.call), null, 2));
  } finally {
    await local.runtime.dispose();
  }
}
