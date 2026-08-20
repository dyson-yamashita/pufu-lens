import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { GRAPH_EDGE_TYPES } from '../packages/graph/src/index.ts';

const migrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0026_relational_graph_schema.sql',
);
const initPath = join(import.meta.dirname, '../infra/docker/postgres/init.sql');
const migrationVersion = '0026_relational_graph_schema';

const graphNodesConstraintNames = [
  'graph_nodes_project_node_key_pkey',
  'graph_nodes_project_id_fkey',
  'graph_nodes_kind_check',
  'graph_nodes_node_key_check',
  'graph_nodes_subtype_nonblank_check',
  'graph_nodes_properties_object_check',
] as const;

const graphEdgesConstraintNames = [
  'graph_edges_project_source_target_relation_key',
  'graph_edges_source_node_fkey',
  'graph_edges_target_node_fkey',
  'graph_edges_relation_type_check',
  'graph_edges_properties_object_check',
] as const;

const graphIndexNames = [
  'graph_edges_project_source_relation_target_idx',
  'graph_edges_project_target_relation_source_idx',
] as const;

function extractCheckInValues(sql: string, constraintName: string): readonly string[] {
  const pattern = new RegExp(`CONSTRAINT ${constraintName}[\\s\\S]*?IN\\s*\\(([^)]+)\\)`, 'i');
  const match = sql.match(pattern);
  assert.ok(match, `${constraintName} IN clause is missing`);
  const inClause = match[1];
  assert.ok(inClause !== undefined, `${constraintName} IN clause capture is missing`);
  return inClause
    .split(',')
    .map((entry) => entry.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter((entry) => entry.length > 0);
}

test('0026 creates additive relational graph tables with provider-neutral JSON contracts', async () => {
  const migration = await readFile(migrationPath, 'utf8');

  assert.match(migration, /0026_relational_graph_schema/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.graph_nodes/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.graph_edges/);
  assert.match(
    migration,
    /PRIMARY KEY \(project_id, node_key\)|CONSTRAINT graph_nodes_project_node_key_pkey[\s\S]*PRIMARY KEY \(project_id, node_key\)/,
  );
  assert.match(
    migration,
    /PRIMARY KEY \(project_id, source_node_key, target_node_key, relation_type\)|CONSTRAINT graph_edges_project_source_target_relation_key[\s\S]*PRIMARY KEY \(project_id, source_node_key, target_node_key, relation_type\)/,
  );
  assert.match(migration, /kind IN \('document', 'actor', 'topic'\)/);
  assert.match(migration, /graph_nodes_node_key_check[\s\S]*btrim\(node_key\) <> ''/);
  assert.match(
    migration,
    /graph_nodes_subtype_nonblank_check[\s\S]*subtype IS NULL OR btrim\(subtype\) <> ''/,
  );
  assert.match(migration, /subtype/);
  assert.match(migration, /properties JSONB NOT NULL DEFAULT '\{\}'/);
  assert.match(migration, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(migration, /updated_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(
    migration,
    /REFERENCES public\.projects\(id\) ON DELETE CASCADE|graph_nodes_project_id_fkey[\s\S]*REFERENCES public\.projects\(id\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /REFERENCES public\.graph_nodes \(project_id, node_key\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS graph_edges_project_source_relation_target_idx[\s\S]*\(project_id, source_node_key, relation_type, target_node_key\)/,
  );
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS graph_edges_project_target_relation_source_idx[\s\S]*\(project_id, target_node_key, relation_type, source_node_key\)/,
  );
});

test('0026 and fresh schema share graph table contracts, constraints, and indexes', async () => {
  const [migration, init] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    ...graphNodesConstraintNames,
    ...graphEdgesConstraintNames,
    ...graphIndexNames,
  ]) {
    assert.ok(migration.includes(name), `${name} is missing from migration`);
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }
});

test('relation_type CHECK values match GRAPH_EDGE_TYPES in migration and fresh schema', async () => {
  const [migration, init] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  const migrationValues = extractCheckInValues(migration, 'graph_edges_relation_type_check');
  const initValues = extractCheckInValues(init, 'graph_edges_relation_type_check');
  assert.deepEqual(migrationValues, GRAPH_EDGE_TYPES);
  assert.deepEqual(initValues, GRAPH_EDGE_TYPES);
});

test('0026 migration version is seeded by init.sql but not inserted by the migration', async () => {
  const [migration, init] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  assert.match(init, new RegExp(`'${migrationVersion}'`));
  assert.doesNotMatch(migration, /INSERT INTO public\.schema_migrations/i);
});

test('0026 remains additive and non-destructive to existing AGE and application data', async () => {
  const migration = await readFile(migrationPath, 'utf8');

  assert.doesNotMatch(migration, /DROP\s+EXTENSION/i);
  assert.doesNotMatch(migration, /drop_graph/i);
  assert.doesNotMatch(migration, /DROP\s+TABLE/i);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\s+public\.projects\b/i);
  assert.doesNotMatch(migration, /\bUPDATE\s+public\./i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM/i);
  assert.doesNotMatch(migration, /LOAD\s+'age'/i);
  assert.doesNotMatch(migration, /create_graph/i);
});
