import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { GraphPrimaryReadObservation, GraphShadowObservation } from '@pufu-lens/graph/shadow';
import type postgres from 'postgres';
import {
  createPostgresGraphTransitionMutationRepository,
  createPostgresGraphTransitionReadRepository,
} from './postgres-graph-transition.ts';

const productionCompositionFiles = [
  '../../../scripts/index-graph-relations.ts',
  './admin-project-actions.ts',
  './admin-actor-actions.ts',
  './admin-data-source-actions.ts',
  './graph-viewer.ts',
  './chat.ts',
  './synthetic-monitor-route-handler.ts',
] as const;

for (const transitionMode of ['relational-primary', 'relational-only']) {
  test(`${transitionMode} composition reads relational rows without resolving an AGE graph`, async () => {
    let reads = 0;
    const observations: (GraphPrimaryReadObservation | GraphShadowObservation)[] = [];
    const transaction = async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      if (query.includes('SELECT')) {
        assert.match(query, /public\.graph_nodes/);
        reads++;
        return [{ count: 7 }];
      }
      return [];
    };
    const sql = Object.assign(
      () => {
        assert.fail('AGE project lookup must not run');
      },
      {
        begin: async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      },
    ) as unknown as postgres.Sql;
    const reader = createPostgresGraphTransitionReadRepository(sql, {
      transitionMode,
      observer: async (observation) => {
        observations.push(observation);
        throw new Error('observer failure must not change the read');
      },
    });
    assert.equal(
      await reader.countDocumentNode({
        projectId: '73800000-0000-0000-0000-000000000001',
        graphNodeId: 'document:fixture',
      }),
      7,
    );
    assert.equal(reads, 1);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.event, 'graph_primary_read_observation');
    assert.equal(observations[0]?.outcome, 'success');
    assert.doesNotMatch(JSON.stringify(observations), /73800000|document:fixture|SELECT/);
  });
}

test('relational-only composition does not resolve AGE on relational database failure', async () => {
  let ageCalls = 0;
  const sql = Object.assign(
    () => {
      ageCalls++;
      throw new Error('AGE access');
    },
    {
      begin: async () => {
        throw Object.assign(new Error('unavailable'), { code: '08006' });
      },
    },
  ) as unknown as postgres.Sql;
  const reader = createPostgresGraphTransitionReadRepository(sql, {
    transitionMode: 'relational-only',
    observer: () => {},
  });
  await assert.rejects(
    reader.countDocumentNode({
      projectId: '73800000-0000-0000-0000-000000000001',
      graphNodeId: 'document:fixture',
    }),
    /Graph read capability unavailable/,
  );
  assert.equal(ageCalls, 0);
});

test('transition composition fails closed for an invalid deployment mode', () => {
  const sql = {} as postgres.Sql;
  assert.throws(
    () => createPostgresGraphTransitionReadRepository(sql, { transitionMode: 'unknown' }),
    /Invalid graph transition mode/,
  );
  assert.throws(
    () => createPostgresGraphTransitionMutationRepository(sql, { transitionMode: 'unknown' }),
    /Invalid graph transition mode/,
  );
});

test('production graph composition sites use transition factories instead of direct AGE factories', async () => {
  for (const path of productionCompositionFiles) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /createPostgresGraphTransition(?:Read|Mutation)Repository/);
    assert.doesNotMatch(source, /createPostgresAgeGraph(?:Read|Mutation)Repository/);
  }
});

test('deployment mode remains server-only and defaults from one environment variable', async () => {
  const source = await readFile(new URL('./postgres-graph-transition.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.env\.PUFU_LENS_GRAPH_TRANSITION_MODE/);
  assert.doesNotMatch(source, /projectId.*transitionMode|request.*transitionMode/i);
  assert.doesNotMatch(source, /NEXT_PUBLIC_.*GRAPH_TRANSITION/);
});
