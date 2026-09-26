import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseParityRun } from '../../../scripts/lib/parity-eval.ts';
import { runLocalParity } from '../parity-local.mjs';

test('real workerd keyword runner emits partial snapshots and a failing gate without remote calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-local-'));
  try {
    const report = await runLocalParity(directory, undefined);
    const snapshot = parseParityRun(
      JSON.parse(await readFile(join(directory, 'cloudflare.json'), 'utf8')),
    );
    assert.equal(snapshot.rows.length, 22);
    assert.equal(report.localEvidence.cloudflare.missing.length, 30);
    assert.equal(report.localEvidence.gcp.missing.length, 52);
    assert.equal(report.qualityGate, false);
    assert.equal(report.comparisonComplete, false);
    assert.equal(snapshot.rows.find((row) => row.id === 'keyword-over-length')?.error, 'rejected');
    assert.ok(snapshot.rows.every((row) => row.scopePass && row.mutationPass === null));
    assert.ok(snapshot.rows.some((row) => row.chunkIds.length > 0));
    assert.equal(snapshot.metadata.embedding.mode, 'synthetic');
    const serialized = await readFile(join(directory, 'report.json'), 'utf8');
    assert.equal(serialized.includes('normalizedQuery'), false);
    assert.equal(serialized.includes('content'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
