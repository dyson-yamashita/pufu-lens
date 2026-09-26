import { type KeywordRun, parseKeywordRun } from './keyword-eval.ts';
import { type ParityRun, parseParityRun } from './parity-eval.ts';
import { parityFixture, parityFixtureHash, parityMappingHash } from './parity-fixture.ts';
import type { collectGraphParity } from './parity-graph.ts';

/** Builds a local-only partial snapshot from fresh keyword and optional Graph observations.
 * Null observations remain unknown and fail the hard gate; no embedding or Chat quality is claimed.
 */
export function localKeywordSnapshot(
  profile: ParityRun['metadata']['profile'],
  codeCommit: string,
  runId: string,
  run: KeywordRun | null,
  graphRun: Awaited<ReturnType<typeof collectGraphParity>> | null = null,
) {
  if (run) parseKeywordRun(run);
  const rows = (run?.cases ?? []).map((result) => {
    const test = parityFixture.cases.find((test) => test.id === `keyword-${result.id}`);
    if (test?.kind !== 'keyword') throw new Error('Unknown keyword measurement');
    return {
      id: test.id,
      status: result.status === 'ok' ? 'ok' : 'error',
      error: result.status === 'ok' ? null : result.status,
      chunkIds: result.chunkIds,
      finalDocumentIds: [],
      citationDocumentIds: [],
      tools: [],
      graph: [],
      scopePass: result.chunkIds.every((id) =>
        parityFixture.chunks.some((chunk) => chunk.id === id && chunk.projectId === test.projectId),
      ),
      mutationPass: null,
      rubricPass: null,
      criticalErrors: 0,
    };
  });
  const snapshot = parseParityRun({
    metadata: {
      runId,
      codeCommit,
      profile,
      region: 'local',
      fixtureVersion: parityFixture.version,
      fixtureHash: parityFixtureHash,
      schemaVersion: parityFixture.schemaVersion,
      mappingHash: parityMappingHash,
      // No real embedding was generated. The deliberately incompatible label prevents quality claims.
      embedding: { mode: 'synthetic', model: 'not-executed', dimensions: 1536, metric: 'cosine' },
    },
    rows: [...rows, ...(graphRun?.rows ?? [])],
  });
  return {
    snapshot,
    evidence: {
      environment: 'local-only',
      adapter: run?.provider ?? 'not-executed',
      graphAdapter: graphRun
        ? profile === 'gcp'
          ? 'postgres-relational'
          : 'd1-workerd'
        : 'not-executed',
      graphObservations: graphRun?.observations ?? [],
      missing: parityFixture.cases
        .filter((test) => !snapshot.rows.some((row) => row.id === test.id))
        .map((test) => ({
          id: test.id,
          reason:
            test.kind === 'semantic' || test.kind === 'hybrid'
              ? 'real-embedding-not-measured-synthetic-evidence-separate'
              : test.kind !== 'keyword' && test.kind !== 'graph' && test.kind !== 'mutation'
                ? 'runner-not-implemented'
                : (test.kind === 'keyword' ? run : graphRun) === null
                  ? 'local-backend-not-configured'
                  : 'case-not-returned',
        })),
      unmeasuredObservations: [
        'keyword-mutation',
        'chat-rubric',
        'real-embedding',
        'remote-authz',
        ...(graphRun ? [] : ['graph-mutation']),
      ],
      latency: [
        ...(run?.cases ?? []).map(({ id, latencyMs }) => ({ id: `keyword-${id}`, latencyMs })),
        ...(graphRun?.observations ?? []).map(({ id, latencyMs }) => ({ id, latencyMs })),
      ],
      remoteMetrics: null,
    },
  };
}
