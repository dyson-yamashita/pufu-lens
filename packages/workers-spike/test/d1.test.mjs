import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { GRAPH_EDGE_TYPES } from '@pufu-lens/graph';
import { Miniflare } from 'miniflare';
import { buildWorker } from '../build.mjs';

let runtime, db;
const relations = [...GRAPH_EDGE_TYPES];
before(async () => {
  const { script } = await buildWorker('d1-worker');
  runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'synthetic-graph' },
    outboundService: () => new Response(null, { status: 403 }),
  });
  await runtime.ready;
  db = await runtime.getD1Database('DB');
  const schema = await readFile(new URL('../d1/0001_graph.sql', import.meta.url), 'utf8');
  await db.batch(
    schema
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
});
after(async () => runtime?.dispose());

async function call(operation, input, expected = 200) {
  const response = await runtime.dispatchFetch('http://local.test/graph', {
    method: 'POST',
    body: JSON.stringify({ operation, input }),
  });
  assert.equal(response.status, expected, `${operation}: ${JSON.stringify(input)}`);
  return (await response.json()).result;
}
async function project(id) {
  await db.prepare('INSERT INTO projects VALUES (?)').bind(id).run();
}
async function node(projectId, graphNodeId, label = 'Document', properties = {}) {
  return call('upsertNode', {
    projectId,
    graphNodeId,
    labels: [label],
    properties: {
      ...(label === 'Document'
        ? { docType: 'web_page', documentId: graphNodeId }
        : label === 'Topic'
          ? { topicType: 'keyword' }
          : {}),
      ...properties,
    },
  });
}
async function edge(
  projectId,
  fromGraphNodeId,
  toGraphNodeId,
  relationType = 'RELATED_TO',
  properties = {},
) {
  return call('upsertEdge', {
    projectId,
    fromGraphNodeId,
    toGraphNodeId,
    relationType,
    properties,
  });
}
async function query(sql, ...values) {
  return (
    await db
      .prepare(sql)
      .bind(...values)
      .all()
  ).results;
}
async function preset(projectId, documentGraphNodeIds, presetId = 'recent-relations') {
  return call('readPreset', { projectId, documentGraphNodeIds, presetId });
}

test('D1 schema enforces project/composite FK, unique, kinds, JSON and all nine relation types', async () => {
  await project('schema-a');
  await project('schema-b');
  await node('schema-a', 'a');
  await node('schema-b', 'b');
  await assert.rejects(
    db.prepare("INSERT INTO graph_edges VALUES ('schema-a','a','b','RELATED_TO','{}')").run(),
  );
  await assert.rejects(
    db.prepare("INSERT INTO graph_nodes VALUES ('absent','a','document',NULL,'{}')").run(),
  );
  await assert.rejects(
    db.prepare("INSERT INTO graph_nodes VALUES ('schema-a','a','document',NULL,'{}')").run(),
  );
  for (const [kind, properties] of [
    ['bad', '{}'],
    ['document', '[]'],
    ['document', 'bad'],
  ]) {
    await assert.rejects(
      db
        .prepare('INSERT INTO graph_nodes VALUES (?,?,?,?,?)')
        .bind('schema-a', 'bad', kind, null, properties)
        .run(),
    );
  }
  await node('schema-a', 'b');
  for (const relation of relations) {
    await edge('schema-a', 'a', 'b', relation);
    await edge('schema-a', 'a', 'b', relation);
  }
  assert.equal((await query("SELECT * FROM graph_edges WHERE project_id='schema-a'")).length, 9);
  await assert.rejects(
    db.prepare("INSERT INTO graph_edges VALUES ('schema-a','a','b','UNKNOWN','{}')").run(),
  );
  const counts = await call('countRelations', {
    projectId: 'schema-a',
    graphNodeId: 'a',
    relationTypes: relations,
  });
  assert.deepEqual(counts, Object.fromEntries(relations.map((r) => [r, 1])));
  assert.equal(await call('countDocumentNode', { projectId: 'schema-b', graphNodeId: 'a' }), 0);
});

test('node sparse upsert uses shallow JSON merge with null, boolean, array and quoted keys', async () => {
  await project('json');
  await node('json', 'doc', 'Document', {
    title: 'retained',
    nested: { a: 1, b: 2 },
    value: 1,
    flag: true,
    quoted: 'a"b',
    arr: [1, 2],
  });
  await node('json', 'doc', 'Document', {
    nested: { c: 3 },
    value: null,
    flag: false,
    'a.b': 'literal',
  });
  const [row] = await query("SELECT properties FROM graph_nodes WHERE project_id='json'");
  const p = JSON.parse(row.properties);
  assert.deepEqual(p.nested, { c: 3 });
  assert.equal(p.value, null);
  assert.equal(p.flag, false);
  assert.equal(p.title, 'retained');
  assert.equal(p.quoted, 'a"b');
  assert.deepEqual(p.arr, [1, 2]);
  assert.equal(p['a.b'], 'literal');
});

test('SAME_AS canonicalization uses UTF-8 and edge retry replaces properties', async () => {
  await project('canonical');
  await node('canonical', '\uE000');
  await node('canonical', '😀');
  await edge('canonical', '😀', '\uE000', 'SAME_AS', { old: 1 });
  await edge('canonical', '\uE000', '😀', 'SAME_AS', { next: 2 });
  const result = await query("SELECT * FROM graph_edges WHERE project_id='canonical'");
  assert.equal(result.length, 1);
  assert.equal(result[0].source_node_key, '\uE000');
  assert.deepEqual(JSON.parse(result[0].properties), { next: 2 });
  await call(
    'upsertEdge',
    {
      projectId: 'canonical',
      fromGraphNodeId: '😀',
      toGraphNodeId: '😀',
      relationType: 'SAME_AS',
      properties: {},
    },
    400,
  );
});

test('1-hop and Topic-only 2-hop are scoped, directed-insensitive, deduped and relation bounded', async () => {
  await project('read');
  await project('read-other');
  for (const p of ['read', 'read-other']) {
    await node(p, 'seed');
    await node(p, 'topic', 'Topic');
    for (let i = 0; i < 8; i++) {
      await node(p, `d${i}`);
      await edge(p, 'seed', `d${i}`, 'RELATED_TO');
      await edge(p, `d${i}`, 'seed', 'SAME_AS');
      await edge(p, `d${i}`, 'topic', 'MENTIONS');
    }
    await edge(p, 'topic', 'seed', 'MENTIONS');
  }
  await node('read-other', 'secret');
  await edge('read-other', 'seed', 'secret', 'RELATED_TO');
  const result = await call('findRelatedDocuments', {
    projectId: 'read',
    seedDocumentIds: ['seed', 'seed'],
  });
  assert.equal(result.status, 'success');
  assert.equal(result.candidates.length, 12);
  for (const [relation, limit, hop] of [
    ['SAME_AS', 2, 1],
    ['RELATED_TO', 5, 1],
    ['MENTIONS', 5, 2],
  ]) {
    const candidates = result.candidates.filter((c) => c.relationType === relation);
    assert.equal(candidates.length, limit);
    assert.ok(candidates.every((c) => c.hopCount === hop && c.seedDocumentId === 'seed'));
  }
  assert.ok(result.candidates.every((c) => c.documentId !== 'secret' && c.documentId !== 'seed'));
  const zero = await call('findRelatedDocuments', {
    projectId: 'read',
    seedDocumentIds: ['seed'],
    relationLimits: { SAME_AS: 0, RELATED_TO: 1, MENTIONS: 0 },
  });
  assert.equal(zero.candidates.length, 1);
  await node('read', 'topic-duplicate', 'Topic');
  await edge('read', 'seed', 'topic-duplicate', 'MENTIONS');
  await edge('read', 'topic-duplicate', 'd0', 'MENTIONS');
  await node('read', 'actor-only', 'Actor');
  await node('read', 'actor-neighbor');
  await edge('read', 'seed', 'actor-only', 'MENTIONS');
  await edge('read', 'actor-only', 'actor-neighbor', 'MENTIONS');
  const deduped = await call('findRelatedDocuments', {
    projectId: 'read',
    seedDocumentIds: ['seed', 'd0'],
    relationLimits: { SAME_AS: 0, RELATED_TO: 0, MENTIONS: 50 },
  });
  assert.deepEqual(deduped.candidates.map((c) => c.documentId).sort(), [
    'd1',
    'd2',
    'd3',
    'd4',
    'd5',
    'd6',
    'd7',
  ]);
  assert.deepEqual(
    await call('findRelatedDocuments', { projectId: 'read', seedDocumentIds: ['absent'] }),
    { status: 'success', candidates: [] },
  );
  await call(
    'findRelatedDocuments',
    { projectId: 'read', seedDocumentIds: ['seed'], relationLimits: { RELATED_TO: -1 } },
    400,
  );
});

test('Viewer preserves normalized fields, deterministic edge IDs and eligible document filtering', async () => {
  await project('viewer');
  await node('viewer', 'doc', 'Document', { title: '合成文書' });
  await node('viewer', 'hidden');
  await node('viewer', 'actor', 'Actor', { displayName: '合成人物' });
  await edge('viewer', 'actor', 'doc', 'AUTHORED', { via: 'fixture' });
  await edge('viewer', 'doc', 'hidden');
  const result = await preset('viewer', ['doc'], 'actor-documents');
  assert.equal(result.rowCount, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.nodes.map((n) => n.label),
    ['合成人物', '合成文書'],
  );
  assert.equal(
    result.edges[0].id,
    createHash('sha256')
      .update(JSON.stringify([true, 'actor', 'doc', 'AUTHORED']))
      .digest('hex')
      .slice(0, 16),
  );
  assert.deepEqual(result.rawRows[0], {
    edgeLabel: 'AUTHORED',
    edgeProperties: { via: 'fixture' },
    edgeSource: 'actor',
    edgeTarget: 'doc',
    sourceNodeKey: 'actor',
    targetNodeKey: 'doc',
  });
  assert.equal((await preset('viewer', ['doc'])).edges.length, 1);
  assert.equal((await preset('viewer', ['doc', 'hidden'])).edges.length, 2);
  assert.equal((await preset('viewer', [])).rowCount, 0);
});

test('Actor merge atomically rewires nine types, dedupes collisions, removes self edges and is retry safe', async () => {
  await project('merge');
  await project('merge-other');
  for (const p of ['merge', 'merge-other']) {
    await node(p, 'primary', 'Actor');
    await node(p, 'secondary', 'Actor');
    await node(p, 'doc');
  }
  for (const relation of relations) {
    await edge('merge', 'secondary', 'doc', relation, { old: true });
  }
  await edge('merge', 'primary', 'doc', 'AUTHORED', { winner: true });
  await edge('merge', 'doc', 'secondary', 'REPLY_TO');
  await edge('merge', 'secondary', 'primary', 'SAME_AS');
  await edge('merge-other', 'secondary', 'doc');
  const input = {
    projectId: 'merge',
    primaryActorId: 'primary-id',
    primaryGraphNodeId: 'primary',
    secondaryGraphNodeId: 'secondary',
  };
  assert.deepEqual(await call('mergeActorGraphNodes', input), {
    status: 'merged',
    deletedCount: 1,
  });
  const result = await query("SELECT * FROM graph_edges WHERE project_id='merge'");
  assert.equal(result.length, 10);
  assert.ok(
    result.every(
      (r) =>
        r.source_node_key !== 'secondary' &&
        r.target_node_key !== 'secondary' &&
        r.source_node_key !== r.target_node_key,
    ),
  );
  assert.deepEqual(JSON.parse(result.find((r) => r.relation_type === 'AUTHORED').properties), {
    winner: true,
  });
  assert.ok(
    result
      .filter((r) => r.relation_type !== 'AUTHORED')
      .every((r) => JSON.parse(r.properties).actorId === 'primary-id'),
  );
  assert.equal((await call('mergeActorGraphNodes', input)).status, 'skipped');
  assert.equal((await query("SELECT * FROM graph_edges WHERE project_id='merge-other'")).length, 1);
});

test('missing primary and mid-batch trigger failure preserve the complete pre-merge graph', async () => {
  await project('rollback');
  await node('rollback', 'secondary', 'Actor');
  await node('rollback', 'doc');
  await edge('rollback', 'secondary', 'doc');
  const input = {
    projectId: 'rollback',
    primaryActorId: 'p',
    primaryGraphNodeId: 'primary',
    secondaryGraphNodeId: 'secondary',
  };
  assert.equal((await call('mergeActorGraphNodes', input)).status, 'unavailable');
  await node('rollback', 'primary', 'Actor');
  const before = await query("SELECT * FROM graph_edges WHERE project_id='rollback'");
  await db
    .prepare(
      "CREATE TRIGGER fail_merge BEFORE DELETE ON graph_nodes WHEN OLD.project_id='rollback' AND OLD.node_key='secondary' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    )
    .run();
  assert.equal((await call('mergeActorGraphNodes', input)).status, 'unavailable');
  assert.deepEqual(await query("SELECT * FROM graph_edges WHERE project_id='rollback'"), before);
  assert.equal((await query("SELECT * FROM graph_nodes WHERE project_id='rollback'")).length, 3);
  await db.prepare('DROP TRIGGER fail_merge').run();
});

test('document cleanup handles >100 IDs atomically and protects Actors, Topics and other projects', async () => {
  await project('cleanup');
  await project('cleanup-other');
  await node('cleanup', 'actor', 'Actor');
  await node('cleanup', 'topic', 'Topic');
  await node('cleanup-other', 'd0');
  const keys = Array.from({ length: 110 }, (_, i) => `d${i}`);
  await db.batch(
    keys.map((k) =>
      db
        .prepare("INSERT INTO graph_nodes VALUES (?,?,'document','web_page',?)")
        .bind('cleanup', k, JSON.stringify({ documentId: k })),
    ),
  );
  await edge('cleanup', 'actor', 'd0', 'AUTHORED');
  await edge('cleanup', 'd0', 'topic', 'MENTIONS');
  await call(
    'deleteDocumentGraphNodes',
    { projectId: 'cleanup', graphNodeIds: [...keys, 'x'.repeat(100_000)] },
    400,
  );
  assert.equal(
    (await query("SELECT * FROM graph_nodes WHERE project_id='cleanup' AND kind='document'"))
      .length,
    110,
  );
  assert.equal(
    await call('deleteDocumentGraphNodes', {
      projectId: 'cleanup',
      graphNodeIds: [...keys, 'actor', 'topic'],
    }),
    110,
  );
  assert.equal((await query("SELECT * FROM graph_nodes WHERE project_id='cleanup'")).length, 2);
  assert.equal((await query("SELECT * FROM graph_edges WHERE project_id='cleanup'")).length, 0);
  assert.equal(
    await call('countDocumentNode', { projectId: 'cleanup-other', graphNodeId: 'd0' }),
    1,
  );
});

test('lifecycle requires existing project and delete remains scoped', async () => {
  await call('ensureProjectGraph', { projectId: 'absent' }, 400);
  await call('ensureProjectGraph', { projectId: 'schema-a' });
  await call('deleteProjectGraph', { projectId: 'schema-a' });
  assert.equal((await query("SELECT * FROM graph_nodes WHERE project_id='schema-a'")).length, 0);
  assert.equal((await query("SELECT * FROM graph_nodes WHERE project_id='schema-b'")).length, 1);
});

test('Viewer bounds 501 rows and 600 nodes without dangling edges, including >100 eligible IDs', async () => {
  await project('viewer-limit');
  const keys = Array.from({ length: 501 }, (_, i) => `doc-${String(i).padStart(3, '0')}`);
  await node('viewer-limit', 'actor', 'Actor');
  await db.batch(
    keys.map((key) =>
      db
        .prepare("INSERT INTO graph_nodes VALUES (?,?,'document','web_page',?)")
        .bind('viewer-limit', key, JSON.stringify({ documentId: key })),
    ),
  );
  await db.batch(
    keys.map((key) =>
      db
        .prepare("INSERT INTO graph_edges VALUES (?,'actor',?,'AUTHORED','{}')")
        .bind('viewer-limit', key),
    ),
  );
  const result = await preset('viewer-limit', keys, 'actor-documents');
  assert.equal(result.edges.length, 500);
  assert.equal(result.nodes.length, 501);
  assert.equal(result.truncated, true);
  const actors = keys.map((key) => `actor-${key}`);
  await db.batch(
    actors.map((key) =>
      db
        .prepare("INSERT INTO graph_nodes VALUES (?,?,'actor','person','{}')")
        .bind('viewer-limit', key),
    ),
  );
  await db.prepare("DELETE FROM graph_edges WHERE project_id='viewer-limit'").run();
  await db.batch(
    keys.map((key, i) =>
      db
        .prepare("INSERT INTO graph_edges VALUES (?,?,?,'AUTHORED','{}')")
        .bind('viewer-limit', actors[i], key),
    ),
  );
  const bounded = await preset('viewer-limit', keys, 'actor-documents');
  assert.equal(bounded.nodes.length, 600);
  assert.equal(bounded.edges.length, 300);
  assert.equal(bounded.truncated, true);
  assert.ok(
    bounded.edges.every(
      (e) =>
        bounded.nodes.some((n) => n.id === e.source) &&
        bounded.nodes.some((n) => n.id === e.target),
    ),
  );
});

test('parallel merge retries have one winner and cannot partially remove edges', async () => {
  await project('concurrent');
  await node('concurrent', 'p', 'Actor');
  await node('concurrent', 's', 'Actor');
  await node('concurrent', 'd');
  await edge('concurrent', 's', 'd', 'SENT');
  const input = {
    projectId: 'concurrent',
    primaryActorId: 'p',
    primaryGraphNodeId: 'p',
    secondaryGraphNodeId: 's',
  };
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () => call('mergeActorGraphNodes', input)),
  );
  assert.equal(outcomes.filter((r) => r.status === 'merged').length, 1);
  assert.equal(outcomes.filter((r) => r.status === 'skipped').length, 3);
  const remaining = await query("SELECT * FROM graph_edges WHERE project_id='concurrent'");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source_node_key, 'p');
});

test('cleanup rollback and project cascade preserve tenant boundaries', async () => {
  await project('cleanup-rollback');
  for (const key of ['a', 'b']) await node('cleanup-rollback', key);
  await edge('cleanup-rollback', 'a', 'b');
  await db
    .prepare(
      "CREATE TRIGGER fail_cleanup BEFORE DELETE ON graph_nodes WHEN OLD.project_id='cleanup-rollback' AND OLD.node_key='b' BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure'); END",
    )
    .run();
  await call(
    'deleteDocumentGraphNodes',
    { projectId: 'cleanup-rollback', graphNodeIds: ['a', 'b'] },
    400,
  );
  assert.equal(
    (await query("SELECT * FROM graph_nodes WHERE project_id='cleanup-rollback'")).length,
    2,
  );
  assert.equal(
    (await query("SELECT * FROM graph_edges WHERE project_id='cleanup-rollback'")).length,
    1,
  );
  await db.prepare('DROP TRIGGER fail_cleanup').run();
  await db.prepare("DELETE FROM projects WHERE id='cleanup-rollback'").run();
  assert.equal(
    (await query("SELECT * FROM graph_nodes WHERE project_id='cleanup-rollback'")).length,
    0,
  );
  assert.equal(
    (await query("SELECT * FROM graph_edges WHERE project_id='cleanup-rollback'")).length,
    0,
  );
  assert.equal(
    await call('countDocumentNode', { projectId: 'cleanup-other', graphNodeId: 'd0' }),
    1,
  );
});

test('malformed DB properties fail runtime guards; SQL failure is unavailable, not successful empty', async () => {
  await project('bad-row');
  await node('bad-row', 'doc');
  await node('bad-row', 'actor', 'Actor');
  await edge('bad-row', 'actor', 'doc', 'AUTHORED');
  await db
    .prepare(
      "UPDATE graph_nodes SET properties='{" +
        '"graphLabels":[1]' +
        "}' WHERE project_id='bad-row' AND node_key='actor'",
    )
    .run();
  await call(
    'readPreset',
    { projectId: 'bad-row', documentGraphNodeIds: ['doc'], presetId: 'actor-documents' },
    400,
  );
  await db.prepare('ALTER TABLE graph_edges RENAME TO graph_edges_unavailable').run();
  assert.equal((await preset('bad-row', [])).rowCount, 0);
  assert.deepEqual(
    await call('countRelations', { projectId: 'bad-row', graphNodeId: 'doc', relationTypes: [] }),
    {},
  );
  assert.deepEqual(
    await call('findRelatedDocuments', { projectId: 'bad-row', seedDocumentIds: ['doc'] }),
    { status: 'unavailable', candidates: [] },
  );
  await db.prepare('ALTER TABLE graph_edges_unavailable RENAME TO graph_edges').run();
});
