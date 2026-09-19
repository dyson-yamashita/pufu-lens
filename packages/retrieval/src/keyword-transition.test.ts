import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeywordCandidateRepository, RankedChunkCandidate } from './index.js';
import {
  createKeywordTransitionRepository,
  KeywordCandidateUnavailableError,
  KeywordQueryRejectedError,
  type KeywordTransitionObservation,
  parseKeywordTransitionMode,
} from './keyword-transition.js';

function candidate(overrides: Partial<RankedChunkCandidate> = {}): RankedChunkCandidate {
  return {
    canonicalUri: 'https://example.invalid/document-a',
    chunkId: 'chunk-a',
    chunkIndex: 0,
    documentId: 'document-a',
    docType: 'issue',
    rank: 1,
    rawDocumentId: 'raw-a',
    snippet: 'safe synthetic snippet',
    title: 'Synthetic document',
    ...overrides,
  };
}

function repository(search: KeywordCandidateRepository['search']): KeywordCandidateRepository {
  return { search };
}

test('keyword transition mode defaults to PGroonga primary and rejects unknown values', () => {
  assert.equal(parseKeywordTransitionMode(undefined), 'pgroonga-primary');
  assert.equal(parseKeywordTransitionMode(''), 'pgroonga-primary');
  assert.equal(parseKeywordTransitionMode('pgroonga-shadow'), 'pgroonga-shadow');
  assert.equal(parseKeywordTransitionMode('portable-primary'), 'portable-primary');
  assert.throws(
    () => parseKeywordTransitionMode('portable-only'),
    /Invalid keyword transition mode/,
  );
});

test('PGroonga primary mode is untouched and never calls the portable repository', async () => {
  let portableCalls = 0;
  const primary = [candidate()];
  const result = await createKeywordTransitionRepository({
    mode: 'pgroonga-primary',
    pgroonga: repository(async () => primary),
    portable: repository(async () => {
      portableCalls++;
      return [];
    }),
  }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' });

  assert.equal(result, primary);
  assert.equal(portableCalls, 0);
});

test('shadow mode preserves a successful empty primary result and records zero separately from errors', async () => {
  const observations: KeywordTransitionObservation[] = [];
  const result = await createKeywordTransitionRepository({
    mode: 'pgroonga-shadow',
    now: () => 100,
    observer: (observation) => {
      observations.push(observation);
    },
    pgroonga: repository(async () => []),
    portable: repository(async () => []),
  }).search({ limit: 5, normalizedQuery: 'absent', projectId: 'project-a' });

  assert.deepEqual(result, []);
  assert.deepEqual(observations, [
    {
      capability: 'keyword',
      event: 'keyword_transition_observation',
      fallbackLatencyMs: 0,
      fallbackProvider: 'none',
      mismatchCategories: [],
      mode: 'pgroonga-shadow',
      operation: 'search',
      outcome: 'success',
      primaryCandidateCount: 0,
      primaryLatencyMs: 0,
      primaryProvider: 'pgroonga',
      reason: 'none',
      shadowCandidateCount: 0,
      shadowLatencyMs: 0,
      shadowProvider: 'portable',
    },
  ]);
});

test('shadow comparison reports rank/provenance mismatch without exposing candidate data', async () => {
  const observations: KeywordTransitionObservation[] = [];
  const result = await createKeywordTransitionRepository({
    mode: 'pgroonga-shadow',
    observer: (observation) => {
      observations.push(observation);
    },
    pgroonga: repository(async () => [candidate({ rank: 1 })]),
    portable: repository(async () => [
      candidate({ rank: 2, snippet: 'portable synthetic snippet' }),
    ]),
  }).search({ limit: 5, normalizedQuery: 'private query', projectId: 'project-a' });

  assert.equal(result[0]?.rank, 1);
  assert.deepEqual(observations[0]?.mismatchCategories, ['rank', 'snippet_provenance']);
  assert.equal(observations[0]?.outcome, 'mismatch');
  assert.doesNotMatch(JSON.stringify(observations), /private query|synthetic snippet|chunk-a/);
});

test('shadow errors do not alter the PGroonga result and do not leak the error text', async () => {
  const observations: KeywordTransitionObservation[] = [];
  const result = await createKeywordTransitionRepository({
    mode: 'pgroonga-shadow',
    observer: (observation) => {
      observations.push(observation);
    },
    pgroonga: repository(async () => [candidate()]),
    portable: repository(async () => {
      throw new Error('secret SQL text');
    }),
  }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' });

  assert.equal(result.length, 1);
  assert.equal(observations[0]?.outcome, 'shadow_error');
  assert.doesNotMatch(JSON.stringify(observations), /secret SQL text/);
});

test('portable primary treats an empty result as authoritative and does not fallback', async () => {
  let fallbackCalls = 0;
  const observations: KeywordTransitionObservation[] = [];
  const result = await createKeywordTransitionRepository({
    mode: 'portable-primary',
    observer: (observation) => {
      observations.push(observation);
    },
    pgroonga: repository(async () => {
      fallbackCalls++;
      return [candidate()];
    }),
    portable: repository(async () => []),
  }).search({ limit: 5, normalizedQuery: 'absent', projectId: 'project-a' });

  assert.deepEqual(result, []);
  assert.equal(fallbackCalls, 0);
  assert.equal(observations[0]?.outcome, 'success');
  assert.equal(observations[0]?.primaryCandidateCount, 0);
  assert.equal(observations[0]?.reason, 'none');
});

test('portable primary falls back once on provider failure and preserves PGroonga provenance', async () => {
  const observations: KeywordTransitionObservation[] = [];
  let fallbackCalls = 0;
  const fallback = [candidate({ canonicalUri: 'https://example.invalid/pgroonga' })];
  const result = await createKeywordTransitionRepository({
    mode: 'portable-primary',
    observer: (observation) => {
      observations.push(observation);
    },
    pgroonga: repository(async (input) => {
      fallbackCalls++;
      assert.deepEqual(input, { limit: 5, normalizedQuery: 'query', projectId: 'project-a' });
      return fallback;
    }),
    portable: repository(async () => {
      throw new Error('portable unavailable');
    }),
  }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' });

  assert.equal(result, fallback);
  assert.equal(fallbackCalls, 1);
  assert.equal(observations[0]?.outcome, 'fallback_success');
  assert.equal(observations[0]?.fallbackCandidateCount, 1);
  assert.equal(observations[0]?.reason, 'primary_error');
  assert.doesNotMatch(JSON.stringify(observations), /portable unavailable/);
});

test('portable query rejection never falls back', async () => {
  let fallbackCalls = 0;
  const rejected = new KeywordQueryRejectedError('invalid query');
  await assert.rejects(
    createKeywordTransitionRepository({
      mode: 'portable-primary',
      pgroonga: repository(async () => {
        fallbackCalls++;
        return [];
      }),
      portable: repository(async () => {
        throw rejected;
      }),
    }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' }),
    (error) => error === rejected,
  );
  assert.equal(fallbackCalls, 0);
});

test('both providers unavailable return a fixed error and distinguish it from a successful zero', async () => {
  const observations: KeywordTransitionObservation[] = [];
  await assert.rejects(
    createKeywordTransitionRepository({
      mode: 'portable-primary',
      observer: (observation) => {
        observations.push(observation);
      },
      pgroonga: repository(async () => {
        throw new Error('fallback secret');
      }),
      portable: repository(async () => {
        throw new Error('primary secret');
      }),
    }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' }),
    (error) =>
      error instanceof KeywordCandidateUnavailableError &&
      error.message === 'Keyword candidate capability unavailable.',
  );
  assert.equal(observations[0]?.outcome, 'unavailable');
  assert.equal(observations[0]?.reason, 'fallback_error');
  assert.doesNotMatch(JSON.stringify(observations), /secret/);
});

test('portable primary timeout activates fallback with the fixed outer deadline', async () => {
  const callbacks: (() => void)[] = [];
  const observations: KeywordTransitionObservation[] = [];
  const resultPromise = createKeywordTransitionRepository({
    mode: 'portable-primary',
    observer: (observation) => {
      observations.push(observation);
    },
    scheduleTimeout: (callback, delayMs) => {
      assert.equal(delayMs, 6_000);
      callbacks.push(callback);
      return callback;
    },
    cancelTimeout: () => undefined,
    pgroonga: repository(async () => [candidate()]),
    portable: repository(() => new Promise(() => {})),
  }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  callbacks[0]?.();

  assert.equal((await resultPromise).length, 1);
  assert.equal(observations[0]?.outcome, 'fallback_success');
});

test('observer failures never alter provider behavior', async () => {
  const result = await createKeywordTransitionRepository({
    mode: 'portable-primary',
    observer: () => {
      throw new Error('observer failure');
    },
    pgroonga: repository(async () => [candidate()]),
    portable: repository(async () => {
      throw new Error('portable failure');
    }),
  }).search({ limit: 5, normalizedQuery: 'query', projectId: 'project-a' });

  assert.equal(result.length, 1);
});
