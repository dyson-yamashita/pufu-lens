import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasDrainRemainingWork,
  hasGraphStep,
  shouldContinueDrainAfterBatch,
  shouldCountParsedRaw,
  shouldFailDrainAtLimit,
  summarizeDrainRemaining,
} from './ingest-workflow-drain.ts';

test('shouldFailDrainAtLimit fails only when selected steps still have remaining work', () => {
  assert.equal(
    shouldFailDrainAtLimit(['parse', 'chunk', 'graph'], { parseQueue: 0, parsedRaw: 1 }),
    true,
  );
  assert.equal(shouldFailDrainAtLimit(['parse'], { parseQueue: 0, parsedRaw: 1 }), false);
  assert.equal(shouldFailDrainAtLimit(['chunk'], { parseQueue: 0, parsedRaw: 0 }), false);
});

test('hasDrainRemainingWork uses parseQueue for parse and parsedRaw for downstream steps', () => {
  assert.equal(hasDrainRemainingWork(['parse'], { parseQueue: 2, parsedRaw: 0 }), true);
  assert.equal(hasDrainRemainingWork(['parse'], { parseQueue: 0, parsedRaw: 5 }), false);
  assert.equal(hasDrainRemainingWork(['chunk'], { parseQueue: 0, parsedRaw: 3 }), true);
  assert.equal(hasDrainRemainingWork(['graph'], { parseQueue: 0, parsedRaw: 1 }), true);
  assert.equal(hasDrainRemainingWork(['resolve'], { parseQueue: 0, parsedRaw: 1 }), true);
  assert.equal(hasDrainRemainingWork(['chunk', 'graph'], { parseQueue: 0, parsedRaw: 0 }), false);
});

test('indexed-only backlog does not count as remaining drain work', () => {
  assert.equal(hasDrainRemainingWork(['chunk'], { parseQueue: 0, parsedRaw: 0 }), false);
  assert.equal(hasDrainRemainingWork(['graph'], { parseQueue: 0, parsedRaw: 0 }), false);
  assert.equal(
    hasDrainRemainingWork(['parse', 'chunk', 'graph'], { parseQueue: 0, parsedRaw: 0 }),
    false,
  );
});

test('shouldCountParsedRaw is true only when downstream steps are selected', () => {
  assert.equal(shouldCountParsedRaw(['parse']), false);
  assert.equal(shouldCountParsedRaw(['chunk']), true);
  assert.equal(shouldCountParsedRaw(['resolve', 'graph']), true);
});

test('shouldContinueDrainAfterBatch keeps graph drains alive while graph is making progress', () => {
  assert.equal(hasGraphStep(['parse', 'graph']), true);
  assert.equal(
    shouldContinueDrainAfterBatch({
      batchProgress: 10,
      remaining: { parseQueue: 0, parsedRaw: 0 },
      steps: ['graph'],
    }),
    true,
  );
  assert.equal(
    shouldContinueDrainAfterBatch({
      batchProgress: 0,
      remaining: { parseQueue: 0, parsedRaw: 0 },
      steps: ['graph'],
    }),
    false,
  );
  assert.equal(
    shouldContinueDrainAfterBatch({
      batchProgress: 10,
      remaining: { parseQueue: 0, parsedRaw: 0 },
      steps: ['chunk'],
    }),
    false,
  );
});

test('summarizeDrainRemaining exposes queue-oriented counts only', () => {
  assert.deepEqual(summarizeDrainRemaining({ parseQueue: 4, parsedRaw: 2 }), {
    parseQueue: 4,
    parsedRaw: 2,
  });
});
