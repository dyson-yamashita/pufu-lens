import { type KeywordRun, parseKeywordRun } from './keyword-eval.ts';
import { type ParityRun, parseParityRun } from './parity-eval.ts';
import { parityFixture, parityFixtureHash, parityMappingHash } from './parity-fixture.ts';

/** Builds a local-only partial snapshot from fresh keyword adapter observations, never judgments.
 * Null observations remain unknown and fail the hard gate; no embedding or Chat quality is claimed.
 */
export function localKeywordSnapshot(
  profile: ParityRun['metadata']['profile'],
  codeCommit: string,
  runId: string,
  run: KeywordRun | null,
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
    rows,
  });
  return {
    snapshot,
    evidence: {
      environment: 'local-only',
      adapter: run?.provider ?? 'not-executed',
      missing: parityFixture.cases
        .filter((test) => !snapshot.rows.some((row) => row.id === test.id))
        .map((test) => ({
          id: test.id,
          reason:
            test.kind !== 'keyword'
              ? 'runner-not-implemented'
              : run === null
                ? 'local-backend-not-configured'
                : 'case-not-returned',
        })),
      unmeasuredObservations: ['mutation', 'chat-rubric', 'real-embedding', 'remote-authz'],
      latency: (run?.cases ?? []).map(({ id, latencyMs }) => ({ id: `keyword-${id}`, latencyMs })),
      remoteMetrics: null,
    },
  };
}
