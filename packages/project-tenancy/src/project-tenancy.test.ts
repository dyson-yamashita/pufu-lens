import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreateProjectSql,
  deriveProjectIdentifiers,
  escapeSqlLiteral,
  validateGraphName,
  validateProjectSlug,
  validateProjectVisibility,
} from './project-tenancy.js';

test('deriveProjectIdentifiers creates graph name and storage prefix from slug', () => {
  assert.deepEqual(deriveProjectIdentifiers('sample-project-1'), {
    graphName: 'graph_sample_project_1',
    storagePrefix: 'sample-project-1',
  });
});

test('validateProjectSlug rejects single-character slugs', () => {
  assert.throws(() => validateProjectSlug('a'), /Invalid project slug/);
  assert.throws(() => validateProjectSlug('1'), /Invalid project slug/);
});

test('validateProjectSlug rejects unsafe or ambiguous slugs', () => {
  for (const slug of ['Sample', '-sample', 'sample-', 'sample_project', '../sample', '']) {
    assert.throws(() => validateProjectSlug(slug), /Invalid project slug/);
  }
});

test('validateGraphName rejects names that cannot be used as AGE graph names', () => {
  for (const graphName of ['sample', 'graph-sample', 'graph_Sample', 'graph_../sample']) {
    assert.throws(() => validateGraphName(graphName), /Invalid graph name/);
  }
});

test('validateGraphName rejects names longer than PostgreSQL identifiers', () => {
  assert.equal(validateGraphName(`graph_${'a'.repeat(57)}`), `graph_${'a'.repeat(57)}`);
  assert.throws(() => validateGraphName(`graph_${'a'.repeat(58)}`), /63 characters or less/);
  assert.throws(() => deriveProjectIdentifiers('a'.repeat(58)), /63 characters or less/);
});

test('validateProjectVisibility allows only private and public projects', () => {
  assert.equal(validateProjectVisibility('private'), 'private');
  assert.equal(validateProjectVisibility('public'), 'public');
  assert.throws(() => validateProjectVisibility('team'), /Invalid project visibility/);
});

test('escapeSqlLiteral escapes quotes', () => {
  assert.equal(escapeSqlLiteral("Bob's Project"), "'Bob''s Project'");
});

test('buildCreateProjectSql is idempotent for project row and graph creation', () => {
  const sql = buildCreateProjectSql({
    description: "Bob's fixture",
    name: 'Sample A',
    slug: 'sample-a',
  });

  assert.match(sql, /ON CONFLICT \(slug\) DO NOTHING/);
  assert.match(sql, /SET standard_conforming_strings = on/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /graph_sample_a/);
  assert.match(sql, /'Bob''s fixture'/);
  assert.match(sql, /'private'\)/);
});

test('buildCreateProjectSql accepts public visibility', () => {
  const sql = buildCreateProjectSql({
    description: 'Public sample',
    name: 'Sample A',
    slug: 'sample-a',
    visibility: 'public',
  });

  assert.match(sql, /visibility\)/);
  assert.match(sql, /'public'\)/);
});

test('buildCreateProjectSql treats null description as SQL NULL', () => {
  const sql = buildCreateProjectSql({
    description: null,
    name: 'Sample A',
    slug: 'sample-a',
  });

  assert.match(sql, /VALUES \('sample-a', 'Sample A', NULL,/);
});
