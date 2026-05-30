import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreateProjectSql,
  deriveProjectIdentifiers,
  escapeSqlLiteral,
  validateGraphName,
  validateProjectSlug,
} from './project-tenancy.js';

test('deriveProjectIdentifiers creates graph name and storage prefix from slug', () => {
  assert.deepEqual(deriveProjectIdentifiers('sample-project-1'), {
    graphName: 'graph_sample_project_1',
    storagePrefix: 'sample-project-1',
  });
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
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /graph_sample_a/);
  assert.match(sql, /'Bob''s fixture'/);
});
