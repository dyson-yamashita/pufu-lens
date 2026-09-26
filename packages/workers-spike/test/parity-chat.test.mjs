import assert from 'node:assert/strict';
import test from 'node:test';
import { collectD1SyntheticChat } from '../parity-chat-local.mjs';

test('D1 Chat records real selection and stale adapter failure without claiming Chat quality', async () => {
  const result = await collectD1SyntheticChat();
  assert.equal(result.rows.length, 3);
  assert.equal(result.qualityGate, false);
  assert.ok(
    result.rows.every(
      (row) => row.tools.includes('hybrid-search') && row.tools.includes('graph-query'),
    ),
  );
  assert.ok(result.rows.every((row) => row.scopePass === null && row.rubricPass === null));
  assert.equal(result.staleRead.actualError, 'unavailable');
  assert.equal(result.staleRead.returnedCandidates, null);
  assert.equal(result.staleRead.controlBeforeCount, 10);
  assert.equal(result.staleRead.controlAfterCount, 10);
  assert.ok(!result.stubs.includes('fixture-document-fetch'));
  assert.ok(
    result.observations.every((o) => o.documentReads.length > 0 && o.graphReads.length === 1),
  );
  assert.ok(result.observations.some((o) => o.graphReads.some((r) => r.returned.length > 0)));
});
