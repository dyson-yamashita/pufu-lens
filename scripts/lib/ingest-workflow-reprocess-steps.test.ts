import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReprocessWorkflowSteps } from './ingest-workflow-reprocess-steps.ts';

test('normalizeReprocessWorkflowSteps keeps default ingest order when graph or chunk is absent', () => {
  assert.deepEqual(normalizeReprocessWorkflowSteps(['parse', 'resolve', 'chunk', 'graph']), [
    'parse',
    'resolve',
    'graph',
    'chunk',
  ]);
  assert.deepEqual(normalizeReprocessWorkflowSteps(['parse', 'chunk']), ['parse', 'chunk']);
  assert.deepEqual(normalizeReprocessWorkflowSteps(['graph']), ['graph']);
  assert.deepEqual(normalizeReprocessWorkflowSteps(['chunk']), ['chunk']);
});

test('normalizeReprocessWorkflowSteps moves graph before chunk without dropping other steps', () => {
  assert.deepEqual(normalizeReprocessWorkflowSteps(['resolve', 'chunk', 'graph']), [
    'resolve',
    'graph',
    'chunk',
  ]);
  assert.deepEqual(normalizeReprocessWorkflowSteps(['graph', 'chunk']), ['graph', 'chunk']);
  assert.deepEqual(normalizeReprocessWorkflowSteps(['chunk', 'graph']), ['graph', 'chunk']);
});

test('normalizeReprocessWorkflowSteps emits graph and chunk only once', () => {
  assert.deepEqual(
    normalizeReprocessWorkflowSteps(['parse', 'graph', 'resolve', 'chunk', 'graph']),
    ['parse', 'graph', 'chunk', 'resolve'],
  );
});
