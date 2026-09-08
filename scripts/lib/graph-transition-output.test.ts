import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { GraphShadowObservation } from '../../packages/graph/src/shadow.ts';
import { consumeGraphTransitionOutput } from './graph-transition-output.ts';

const ingestWorkflowSource = await readFile(
  new URL('../ingest-workflow.ts', import.meta.url),
  'utf8',
);

test('consumeGraphTransitionOutput emits a valid observation and preserves the pretty script result', () => {
  const observationLine = JSON.stringify({
    capability: 'read',
    event: 'graph_transition_observation',
    mismatchCategories: [],
    operation: 'count_document_node',
    outcome: 'match',
    primaryLatencyMs: 5,
    primaryProvider: 'postgres_age',
    shadowLatencyMs: 3,
    shadowProvider: 'postgres_relational',
  });
  const prettyResult = `{
  "failureCount": 0,
  "decisions": [
    {
      "action": "indexed",
      "documentId": "doc-1"
    }
  ]
}`;
  const stdout = `${observationLine}\n${prettyResult}`;
  const observations: GraphShadowObservation[] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    capability: 'read',
    event: 'graph_transition_observation',
    mismatchCategories: [],
    operation: 'count_document_node',
    outcome: 'match',
    primaryLatencyMs: 5,
    primaryProvider: 'postgres_age',
    shadowLatencyMs: 3,
    shadowProvider: 'postgres_relational',
  });
  assert.equal(resultOutput, prettyResult);
});

test('consumeGraphTransitionOutput delivers multiple valid observations in order and keeps only the final result', () => {
  const observation = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      capability: 'read',
      event: 'graph_transition_observation',
      mismatchCategories: [],
      operation: 'count_document_node',
      outcome: 'match',
      primaryLatencyMs: 5,
      primaryProvider: 'postgres_age',
      shadowLatencyMs: 3,
      shadowProvider: 'postgres_relational',
      ...overrides,
    });
  const prettyResult = `{
  "failureCount": 0,
  "decisions": []
}`;
  const stdout = [
    observation({ outcome: 'match', operation: 'read_preset' }),
    observation({ outcome: 'shadow_error', capability: 'mutation', operation: 'upsert_node' }),
    observation({ outcome: 'shadow_timeout', operation: 'count_relations' }),
    prettyResult,
  ].join('\n');
  const outcomes: GraphShadowObservation['outcome'][] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    outcomes.push(observation.outcome);
  });

  assert.deepEqual(outcomes, ['match', 'shadow_error', 'shadow_timeout']);
  assert.equal(resultOutput, prettyResult);
});

test('consumeGraphTransitionOutput strips identity-bearing and secret-bearing fields from emitted observations', () => {
  const observationLine = JSON.stringify({
    capability: 'read',
    event: 'graph_transition_observation',
    mismatchCategories: ['count'],
    operation: 'count_document_node',
    outcome: 'match',
    primaryLatencyMs: 5,
    primaryProvider: 'postgres_age',
    shadowLatencyMs: 3,
    shadowProvider: 'postgres_relational',
    projectId: 'private-project',
    graphNodeId: 'private-node',
    documentId: 'private-document',
    properties: { graphNodeId: 'leak' },
    content: 'secret body',
    error: 'secret failure',
    token: 'secret-token',
  });
  const prettyResult = `{
  "failureCount": 0,
  "decisions": []
}`;
  const stdout = `${observationLine}\n${prettyResult}`;
  const observations: GraphShadowObservation[] = [];

  consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    capability: 'read',
    event: 'graph_transition_observation',
    mismatchCategories: ['count'],
    operation: 'count_document_node',
    outcome: 'match',
    primaryLatencyMs: 5,
    primaryProvider: 'postgres_age',
    shadowLatencyMs: 3,
    shadowProvider: 'postgres_relational',
  });
  assert.doesNotMatch(
    JSON.stringify(observations[0]),
    /private-|secret|graphNodeId|documentId|properties|content|error|token/i,
  );
});

test('consumeGraphTransitionOutput preserves non-observation events and ignores unknown enum values on matching events', () => {
  const unrelatedEvent = JSON.stringify({
    event: 'workflow_progress',
    step: 'collect',
    message: 'still visible',
  });
  const observation = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      capability: 'read',
      event: 'graph_transition_observation',
      mismatchCategories: [],
      operation: 'count_document_node',
      outcome: 'match',
      primaryLatencyMs: 5,
      primaryProvider: 'postgres_age',
      shadowLatencyMs: 3,
      shadowProvider: 'postgres_relational',
      ...overrides,
    });
  const prettyResult = `{
  "failureCount": 0,
  "decisions": []
}`;
  const stdout = [
    unrelatedEvent,
    observation({ capability: 'compare' }),
    observation({ operation: 'rebuild_graph' }),
    observation({ outcome: 'partial_match' }),
    observation({
      primaryProvider: 'postgres_unknown',
      shadowProvider: 'postgres_unknown',
    }),
    observation({ mismatchCategories: ['identity_leak'] }),
    prettyResult,
  ].join('\n');
  const observations: GraphShadowObservation[] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 0);
  assert.equal(resultOutput, [unrelatedEvent, prettyResult].join('\n'));
});

test('consumeGraphTransitionOutput rejects invalid latency values and accepts finite zero', () => {
  const observation = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      capability: 'read',
      event: 'graph_transition_observation',
      mismatchCategories: [],
      operation: 'count_document_node',
      outcome: 'match',
      primaryLatencyMs: 5,
      primaryProvider: 'postgres_age',
      shadowLatencyMs: 3,
      shadowProvider: 'postgres_relational',
      ...overrides,
    });
  const prettyResult = `{
  "failureCount": 0,
  "decisions": []
}`;
  const stdout = [
    observation({ primaryLatencyMs: -1 }),
    observation({ shadowLatencyMs: Number.NaN }),
    observation({ primaryLatencyMs: null }),
    observation({ shadowLatencyMs: '12' }),
    observation({ primaryLatencyMs: 0, shadowLatencyMs: 0 }),
    prettyResult,
  ].join('\n');
  const observations: GraphShadowObservation[] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.primaryLatencyMs, 0);
  assert.equal(observations[0]?.shadowLatencyMs, 0);
  assert.equal(resultOutput, prettyResult);
});

test('consumeGraphTransitionOutput leaves malformed JSON and ordinary logs unchanged', () => {
  const prettyResult = `{
  "failureCount": 0,
  "decisions": []
}`;
  const stdout = [
    'starting ingest workflow',
    '{not-json',
    '{"event":"graph_transition_observation"',
    'info: collected 3 documents',
    prettyResult,
  ].join('\n');
  const observations: GraphShadowObservation[] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 0);
  assert.equal(resultOutput, stdout);
});

test('consumeGraphTransitionOutput continues when the observer throws', () => {
  const observation = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      capability: 'read',
      event: 'graph_transition_observation',
      mismatchCategories: [],
      operation: 'count_document_node',
      outcome: 'match',
      primaryLatencyMs: 5,
      primaryProvider: 'postgres_age',
      shadowLatencyMs: 3,
      shadowProvider: 'postgres_relational',
      ...overrides,
    });
  const prettyResult = `{
  "failureCount": 0,
  "decisions": []
}`;
  const stdout = [
    observation({ outcome: 'match' }),
    observation({ outcome: 'shadow_error' }),
    prettyResult,
  ].join('\n');
  const outcomes: GraphShadowObservation['outcome'][] = [];
  let throwCount = 0;

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    outcomes.push(observation.outcome);
    throwCount += 1;
    if (throwCount === 1) {
      throw new Error('observer failed');
    }
  });

  assert.deepEqual(outcomes, ['match', 'shadow_error']);
  assert.equal(resultOutput, prettyResult);
});

test('consumeGraphTransitionOutput returns stdout unchanged when no observations are present', () => {
  const stdout = `{
  "failureCount": 0,
  "decisions": []
}`;
  let observerCalls = 0;

  const resultOutput = consumeGraphTransitionOutput(stdout, () => {
    observerCalls += 1;
  });

  assert.equal(observerCalls, 0);
  assert.equal(resultOutput, stdout);
  assert.equal(
    consumeGraphTransitionOutput('', () => {
      observerCalls += 1;
    }),
    '',
  );
});

test('consumeGraphTransitionOutput preserves CRLF line endings on retained output', () => {
  const observationLine = JSON.stringify({
    capability: 'read',
    event: 'graph_transition_observation',
    mismatchCategories: [],
    operation: 'count_document_node',
    outcome: 'match',
    primaryLatencyMs: 1,
    primaryProvider: 'postgres_age',
    shadowLatencyMs: 2,
    shadowProvider: 'postgres_relational',
  });
  const stdout = `log line\r\n${observationLine}\r\n{\r\n  "failureCount": 0\r\n}`;
  const observations: GraphShadowObservation[] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 1);
  assert.equal(resultOutput, `log line\r\n{\r\n  "failureCount": 0\r\n}`);
});

test('consumeGraphTransitionOutput handles a trailing valid observation without a final newline', () => {
  const observationLine = JSON.stringify({
    capability: 'mutation',
    event: 'graph_transition_observation',
    mismatchCategories: ['count'],
    operation: 'upsert_edge',
    outcome: 'mismatch',
    primaryLatencyMs: 4,
    primaryProvider: 'postgres_age',
    shadowLatencyMs: 6,
    shadowProvider: 'postgres_relational',
  });
  const prettyResult = `{
  "failureCount": 1
}`;
  const stdout = `${prettyResult}\n${observationLine}`;
  const observations: GraphShadowObservation[] = [];

  const resultOutput = consumeGraphTransitionOutput(stdout, (observation) => {
    observations.push(observation);
  });

  assert.equal(observations.length, 1);
  assert.equal(resultOutput, `${prettyResult}\n`);
});

test('ingest workflow filters graph transition observations before parsing script output', () => {
  const consumeCallIndex = ingestWorkflowSource.indexOf(
    'const resultOutput = consumeGraphTransitionOutput(stdout',
  );
  const exitCodeIndex = ingestWorkflowSource.indexOf('if (exitCode !== 0)');
  assert.ok(
    consumeCallIndex >= 0,
    'consumeGraphTransitionOutput call must exist in ingest-workflow.ts',
  );
  assert.ok(exitCodeIndex >= 0, 'exit-code handling must exist in ingest-workflow.ts');
  assert.ok(
    consumeCallIndex < exitCodeIndex,
    'consumeGraphTransitionOutput must run before exit-code handling',
  );
  assert.match(
    ingestWorkflowSource,
    /consumeGraphTransitionOutput\(stdout,\s*\(observation\)\s*=>\s*\{\s*console\.info\(JSON\.stringify\(observation\)\);\s*\}\)/,
  );
  assert.match(
    ingestWorkflowSource,
    /safeErrorMessage\(stderr \|\| resultOutput \|\| `script exited with \$\{exitCode\}`\)/,
  );
  assert.match(ingestWorkflowSource, /return parseScriptOutput\(resultOutput\);/);
});
