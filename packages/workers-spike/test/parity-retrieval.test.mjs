import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectD1SyntheticRetrieval,
  createParityVectorizeFake,
} from '../parity-retrieval-local.mjs';

test('cosine fake uses vector values and filters, never insertion order, and denies other egress', async () => {
  const fake = createParityVectorizeFake();
  const call = async (method, body) =>
    (
      await fake.fetch(
        new Request(`https://vectorize-fake.invalid/${method}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      )
    ).json();
  await call('upsert', [
    {
      id: 'first',
      namespace: 'alpha',
      metadata: { projectId: 'alpha', model: 'test' },
      values: [0, 1],
    },
    {
      id: 'second',
      namespace: 'alpha',
      metadata: { projectId: 'alpha', model: 'test' },
      values: [1, 0],
    },
    {
      id: 'foreign',
      namespace: 'beta',
      metadata: { projectId: 'beta', model: 'test' },
      values: [1, 0],
    },
  ]);
  const query = {
    values: [1, 0],
    options: { namespace: 'alpha', filter: { projectId: 'alpha', model: 'test' }, topK: 10 },
  };
  assert.deepEqual(
    (await call('query', query)).matches.map((v) => [v.id, v.score]),
    [
      ['second', 1],
      ['first', 0],
    ],
  );
  assert.deepEqual(
    (await call('query', { ...query, values: [0, 1] })).matches.map((v) => v.id),
    ['first', 'second'],
  );
  assert.equal((await fake.fetch(new Request('https://api.openai.com/v1/embeddings'))).status, 403);
});

test('real D1/workerd hydrates full common fixture with fake Vectorize and six fresh adapter calls', async () => {
  const result = await collectD1SyntheticRetrieval();
  assert.equal(result.storedVectors, 37);
  assert.equal(result.fakeCalls.upsert, 36);
  assert.equal(result.fakeCalls.query, 6);
  assert.equal(result.rows.length, 6);
  assert.equal(result.vectorize, 'fake-exact-cosine');
  assert.equal(result.qualityGate, false);
  assert.ok(result.rows.every((row) => row.scopePass && row.chunkIds.length === 10));
  assert.ok(result.rows.every((row) => row.mutationPass === null && row.rubricPass === null));
  assert.ok(
    result.rows
      .filter((row) => row.id.startsWith('hybrid'))
      .every((row) => row.finalDocumentIds.length > 0 && row.finalDocumentIds.length <= 5),
  );
});
