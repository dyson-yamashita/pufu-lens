import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
