import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import {
  createPostgresAgeGraphMutationRepository,
  parseAgeGraphMutationCountRow,
} from './postgres-age-mutation.js';

test('AGE graph mutation adapter exposes project-scoped mutation methods', () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphMutationRepository(sql);
  assert.equal(typeof repository.ensureProjectGraph, 'function');
  assert.equal(typeof repository.deleteProjectGraph, 'function');
  assert.equal(typeof repository.upsertNode, 'function');
  assert.equal(typeof repository.upsertEdge, 'function');
  assert.equal(typeof repository.mergeActorGraphNodes, 'function');
  assert.equal(typeof repository.deleteDocumentGraphNodes, 'function');
});

test('AGE graph mutation adapter resolves graph_name internally by projectId', async () => {
  const unsafeQueries: string[] = [];
  const taggedQueries: string[] = [];
  const transaction = Object.assign(
    (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      taggedQueries.push(String.raw({ raw: strings }, ...values));
      return Promise.resolve([]);
    },
    {
      unsafe(query: string) {
        unsafeQueries.push(query);
        return Promise.resolve([]);
      },
    },
  );
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      taggedQueries.push(String.raw({ raw: strings }, ...values));
      return Promise.resolve([{ graphName: 'graph_sample_a' }]);
    },
    { begin: (callback: (value: unknown) => unknown) => callback(transaction) },
  ) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphMutationRepository(sql);

  await repository.ensureProjectGraph({ projectId: 'project-a' });

  const resolutionQuery = taggedQueries.find((query) => /graph_name AS "graphName"/.test(query));
  assert.ok(resolutionQuery, 'project graph resolution query should exist');
  assert.doesNotMatch(resolutionQuery ?? '', /graph_sample_a/);
  assert.equal(unsafeQueries.length, 1);
  assert.match(unsafeQueries[0] ?? '', /create_graph/);
});

test('AGE graph mutation adapter binds identifiers through the AGE parameter map', async () => {
  const unsafeCalls: Array<{ parameters?: readonly unknown[]; query: string }> = [];
  const transaction = Object.assign(() => Promise.resolve([]), {
    unsafe(query: string, parameters?: readonly unknown[]) {
      unsafeCalls.push({ parameters, query });
      return Promise.resolve([]);
    },
  });
  const sql = Object.assign(() => Promise.resolve([{ graphName: 'graph_sample_a' }]), {
    begin: (callback: (value: unknown) => unknown) => callback(transaction),
  }) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphMutationRepository(sql);

  await repository.upsertNode({
    graphNodeId: 'document:email:msg-with\nnewline',
    labels: ['Document'],
    projectId: 'project-a',
    properties: { documentId: 'document-a' },
  });

  assert.equal(unsafeCalls.length, 1);
  const call = unsafeCalls[0];
  assert.match(call?.query ?? '', /\$graphNodeId/);
  assert.doesNotMatch(call?.query ?? '', /msg-with\nnewline/);
  assert.deepEqual(JSON.parse(String(call?.parameters?.[0])), {
    documentId: 'document-a',
    graphLabels: ['Document'],
    graphNodeId: 'document:email:msg-with\nnewline',
  });
  assert.ok(unsafeCalls.every((entry) => entry.query.includes('$1::agtype')));
  assert.ok(unsafeCalls.every((entry) => !entry.query.includes('jsonb::agtype')));
});

test('parseAgeGraphMutationCountRow rejects malformed provider rows', () => {
  assert.equal(parseAgeGraphMutationCountRow({ value: 2 }, 'deleted count'), 2);
  assert.equal(parseAgeGraphMutationCountRow({ value: '3' }, 'deleted count'), 3);
  assert.throws(
    () => parseAgeGraphMutationCountRow({ value: '1.5' }, 'deleted count'),
    /safe integer/,
  );
  assert.throws(
    () => parseAgeGraphMutationCountRow({ value: null }, 'deleted count'),
    /Invalid AGE deleted count/,
  );
});

test('AGE graph mutation adapter rejects empty projectId for lifecycle mutations', async () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphMutationRepository(sql);

  await assert.rejects(
    () => repository.ensureProjectGraph({ projectId: '' }),
    /Invalid graph field: projectId/,
  );
  await assert.rejects(
    () => repository.deleteProjectGraph({ projectId: ' ' }),
    /Invalid graph field: projectId/,
  );
});

test('AGE graph mutation adapter normalizes malformed project graph lookup rows', async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const sql = Object.assign(
      () => Promise.resolve([{ graphName: 'graph_sample_a', providerRow: 'unexpected' }]),
      { begin: (callback: (value: unknown) => unknown) => callback(sql) },
    ) as unknown as postgres.Sql;
    const repository = createPostgresAgeGraphMutationRepository(sql);

    await assert.rejects(
      () => repository.ensureProjectGraph({ projectId: 'project-a' }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }
        assert.equal(error.message, 'Graph mutation capability unavailable.');
        assert.doesNotMatch(error.message, /graph_sample_a|providerRow/);
        return true;
      },
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /graph_mutation_unavailable/);
    assert.match(messages[0] ?? '', /ensure_project_graph/);
    assert.doesNotMatch(messages[0] ?? '', /graph_sample_a|providerRow/);
  } finally {
    console.error = originalError;
  }
});

test('AGE graph mutation adapter normalizes malformed provider counts for cleanup and actor merge', async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const malformedCountTransaction = Object.assign(async () => [], {
      unsafe() {
        return Promise.resolve([{ value: '1.5' }]);
      },
    });
    const cleanupSql = Object.assign(() => Promise.resolve([{ graphName: 'graph_sample_a' }]), {
      begin: (callback: (value: unknown) => unknown) => callback(malformedCountTransaction),
    }) as unknown as postgres.Sql;
    const cleanupRepository = createPostgresAgeGraphMutationRepository(cleanupSql);

    assert.equal(
      await cleanupRepository.deleteDocumentGraphNodes({
        graphNodeIds: ['document:a'],
        projectId: 'project-a',
      }),
      0,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /delete_document_graph_nodes/);
    assert.doesNotMatch(messages[0] ?? '', /1\.5|safe integer/);

    messages.length = 0;
    const mergeSql = Object.assign(() => Promise.resolve([{ graphName: 'graph_sample_a' }]), {
      begin: (callback: (value: unknown) => unknown) => callback(malformedCountTransaction),
    }) as unknown as postgres.Sql;
    const mergeRepository = createPostgresAgeGraphMutationRepository(mergeSql);

    assert.deepEqual(
      await mergeRepository.mergeActorGraphNodes({
        primaryActorId: 'actor-primary',
        primaryGraphNodeId: 'actor:primary',
        projectId: 'project-a',
        secondaryGraphNodeId: 'actor:secondary',
      }),
      { status: 'unavailable' },
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /merge_actor_graph_nodes/);
    assert.doesNotMatch(messages[0] ?? '', /1\.5|safe integer|actor-primary/);
  } finally {
    console.error = originalError;
  }
});

test('AGE graph mutation adapter validation errors skip provider unavailable logs', async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
    const repository = createPostgresAgeGraphMutationRepository(sql);
    await assert.rejects(
      () =>
        repository.upsertEdge({
          fromGraphNodeId: '',
          projectId: 'project-a',
          properties: { confidence: 1 },
          relationType: 'RELATED_TO',
          toGraphNodeId: 'node-b',
        }),
      /Invalid graph field/,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(messages.length, 0);
});

test('AGE graph mutation adapter normalizes lifecycle and upsert provider failures', async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const transaction = Object.assign(async () => [], {
      unsafe() {
        return Promise.reject(
          new Error('postgresql://secret-host/private SELECT * FROM cypher leak'),
        );
      },
    });
    const sql = Object.assign(() => Promise.resolve([{ graphName: 'graph_sample_a' }]), {
      begin: (callback: (value: unknown) => unknown) => callback(transaction),
    }) as unknown as postgres.Sql;
    const repository = createPostgresAgeGraphMutationRepository(sql);

    messages.length = 0;
    await assert.rejects(
      () => repository.ensureProjectGraph({ projectId: 'project-a' }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }
        assert.equal(error.message, 'Graph mutation capability unavailable.');
        assert.doesNotMatch(error.message, /secret-host|cypher|postgresql/);
        return true;
      },
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /graph_mutation_unavailable/);
    assert.match(messages[0] ?? '', /ensure_project_graph/);
    assert.doesNotMatch(messages[0] ?? '', /secret-host|cypher|postgresql/);

    messages.length = 0;
    await assert.rejects(
      () =>
        repository.upsertNode({
          graphNodeId: 'document-a',
          labels: ['Document'],
          projectId: 'project-a',
          properties: { documentId: 'document-a' },
        }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }
        assert.equal(error.message, 'Graph mutation capability unavailable.');
        assert.doesNotMatch(error.message, /secret-host|cypher|postgresql/);
        return true;
      },
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /graph_mutation_unavailable/);
    assert.match(messages[0] ?? '', /upsert_node/);
    assert.doesNotMatch(messages[0] ?? '', /secret-host|cypher leak|postgresql/);

    messages.length = 0;
    const missingGraphSql = (() => Promise.resolve([])) as unknown as postgres.Sql;
    const missingGraphRepository = createPostgresAgeGraphMutationRepository(missingGraphSql);
    await assert.rejects(
      () => missingGraphRepository.ensureProjectGraph({ projectId: 'project-a' }),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }
        assert.equal(error.message, 'Graph mutation capability unavailable.');
        return true;
      },
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /graph_mutation_unavailable/);
    assert.match(messages[0] ?? '', /ensure_project_graph/);
    assert.doesNotMatch(messages[0] ?? '', /secret-host|cypher|postgresql/);
  } finally {
    console.error = originalError;
  }
});

test('AGE graph mutation adapter normalizes unavailable provider errors without sensitive logs', async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const sql = (() =>
      Promise.reject(new Error('postgresql://secret-host/private'))) as unknown as postgres.Sql;
    const repository = createPostgresAgeGraphMutationRepository(sql);
    assert.deepEqual(
      await repository.mergeActorGraphNodes({
        primaryActorId: 'actor-primary',
        primaryGraphNodeId: 'actor:primary',
        projectId: 'project-a',
        secondaryGraphNodeId: 'actor:secondary',
      }),
      { status: 'unavailable' },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /graph_mutation_unavailable/);
  assert.doesNotMatch(messages[0] ?? '', /secret-host|actor-primary|actor:secondary/);
});
