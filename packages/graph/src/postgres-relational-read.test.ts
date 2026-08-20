import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import { GRAPH_PRESET_IDS, type GraphPresetId } from './index.js';
import { GraphReadUnavailableError, isReadUnavailableError } from './postgres-relational-common.js';
import {
  createPostgresRelationalGraphReadRepository,
  deriveRelationalGraphNodeKindSubtype,
  parseRelationalGraphReadRow,
  relationalGraphPresetPreview,
} from './postgres-relational-read.js';

const PROJECT_ID = '71400000-0000-0000-0000-000000000001';
const GRAPH_NODE_ID = 'document:issue-714-seed';

function createReadRepositoryMock(
  transactionResult: unknown,
  transactionExtras?: Record<string, unknown>,
): ReturnType<typeof createPostgresRelationalGraphReadRepository> {
  const transaction = Object.assign(
    (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      void strings;
      void values;
      return Promise.resolve(transactionResult);
    },
    transactionExtras ?? {},
  );
  const sql = Object.assign(() => Promise.resolve([]), {
    begin: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  }) as unknown as postgres.Sql;
  return createPostgresRelationalGraphReadRepository(sql);
}

test('relational graph read adapter exposes project-scoped capability methods', () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresRelationalGraphReadRepository(sql);
  assert.equal(typeof repository.findRelatedDocuments, 'function');
  assert.equal(typeof repository.readPreset, 'function');
  assert.equal(typeof repository.countDocumentNode, 'function');
  assert.equal(typeof repository.countRelations, 'function');
});

test('relationalGraphPresetPreview returns non-empty provider-neutral preset descriptions', () => {
  for (const presetId of GRAPH_PRESET_IDS) {
    const preview = relationalGraphPresetPreview(presetId);
    assert.ok(preview.trim().length > 0, `preview for ${presetId} should be non-empty`);
    assert.doesNotMatch(preview, /\b(SELECT|FROM|JOIN|MATCH|cypher|agtype)\b/i);
    assert.match(preview, new RegExp(presetId.replace('-', '[- ]')));
  }
});

test('deriveRelationalGraphNodeKindSubtype normalizes Document Actor and Topic labels', () => {
  assert.deepEqual(
    deriveRelationalGraphNodeKindSubtype({
      labels: ['Document'],
      properties: {
        docType: 'web_page',
        documentId: '71400000-0000-0000-0000-000000000001',
        graphLabels: ['Document'],
        graphNodeId: 'document:issue-714-seed',
      },
    }),
    {
      kind: 'document',
      normalizedProperties: {
        docType: 'web_page',
        documentId: '71400000-0000-0000-0000-000000000001',
        graphLabels: ['Document'],
        graphNodeId: 'document:issue-714-seed',
      },
      subtype: 'web_page',
    },
  );
  assert.deepEqual(
    deriveRelationalGraphNodeKindSubtype({
      labels: ['Actor'],
      properties: {
        actorId: '71400000-0000-0000-0000-000000000010',
        displayName: 'Fixture Actor',
        graphLabels: ['Actor'],
        graphNodeId: 'actor:issue-714-actor',
      },
    }),
    {
      kind: 'actor',
      normalizedProperties: {
        actorId: '71400000-0000-0000-0000-000000000010',
        displayName: 'Fixture Actor',
        graphLabels: ['Actor'],
        graphNodeId: 'actor:issue-714-actor',
      },
      subtype: 'person',
    },
  );
  assert.deepEqual(
    deriveRelationalGraphNodeKindSubtype({
      labels: ['Topic'],
      properties: {
        graphLabels: ['Topic'],
        graphNodeId: 'topic:issue-714-topic',
        topicType: 'keyword',
      },
    }),
    {
      kind: 'topic',
      normalizedProperties: {
        graphLabels: ['Topic'],
        graphNodeId: 'topic:issue-714-topic',
        topicType: 'keyword',
      },
      subtype: 'keyword',
    },
  );
});

test('parseRelationalGraphReadRow rejects malformed provider rows', () => {
  assert.deepEqual(
    parseRelationalGraphReadRow(
      {
        edgeId: 'edge-1',
        edgeLabel: 'AUTHORED',
        edgeProperties: { actorId: '71400000-0000-0000-0000-000000000010' },
        edgeSource: 'actor:issue-714-actor',
        edgeTarget: 'document:issue-714-seed',
        nodeId: 'actor:issue-714-actor',
        nodeLabel: 'Fixture Actor',
        nodeLabels: ['Actor'],
        nodeProperties: { graphNodeId: 'actor:issue-714-actor' },
      },
      'preset row',
    ),
    {
      edge: {
        id: 'edge-1',
        label: 'AUTHORED',
        properties: { actorId: '71400000-0000-0000-0000-000000000010' },
        source: 'actor:issue-714-actor',
        target: 'document:issue-714-seed',
      },
      node: {
        id: 'actor:issue-714-actor',
        label: 'Fixture Actor',
        labels: ['Actor'],
        properties: { graphNodeId: 'actor:issue-714-actor' },
      },
    },
  );
  assert.throws(
    () =>
      parseRelationalGraphReadRow(
        { nodeId: '', nodeLabel: 'x', nodeLabels: ['Actor'] },
        'preset row',
      ),
    /Invalid relational preset row field: nodeId/,
  );
  assert.throws(
    () =>
      parseRelationalGraphReadRow(
        { nodeId: 'actor:issue-714-actor', nodeLabel: 'x', nodeLabels: [] },
        'preset row',
      ),
    /Invalid relational preset row field: nodeLabels/,
  );
  assert.throws(
    () => parseRelationalGraphReadRow(null, 'preset row'),
    /Invalid relational preset row/,
  );
});

test('countRelations returns zero counts for empty SQL rows', async () => {
  const repository = createReadRepositoryMock([]);
  const counts = await repository.countRelations({
    graphNodeId: GRAPH_NODE_ID,
    projectId: PROJECT_ID,
    relationTypes: ['SENT', 'AUTHORED'],
  });
  assert.deepEqual(counts, { AUTHORED: 0, SENT: 0 });
});

test('countRelations rejects malformed SQL rows as graph read unavailable', async () => {
  const repository = createReadRepositoryMock([{ relationType: 'SENT', count: 1 }, null]);
  await assert.rejects(
    () =>
      repository.countRelations({
        graphNodeId: GRAPH_NODE_ID,
        projectId: PROJECT_ID,
        relationTypes: ['SENT'],
      }),
    (error: unknown) => {
      assert.ok(isReadUnavailableError(error));
      if (error instanceof Error) {
        assert.doesNotMatch(error.message, /714|SENT|null/i);
      }
      return true;
    },
  );
});

test('countRelations rejects allowlist drift and malformed counts as graph read unavailable', async () => {
  const driftRepository = createReadRepositoryMock([{ count: 1, relationType: 'MENTIONS' }]);
  await assert.rejects(
    () =>
      driftRepository.countRelations({
        graphNodeId: GRAPH_NODE_ID,
        projectId: PROJECT_ID,
        relationTypes: ['SENT'],
      }),
    (error: unknown) => isReadUnavailableError(error),
  );

  const malformedCountRepository = createReadRepositoryMock([
    { count: '1.5', relationType: 'SENT' },
  ]);
  await assert.rejects(
    () =>
      malformedCountRepository.countRelations({
        graphNodeId: GRAPH_NODE_ID,
        projectId: PROJECT_ID,
        relationTypes: ['SENT'],
      }),
    (error: unknown) => isReadUnavailableError(error),
  );
});

test('countRelations returns {} for empty relationTypes without executing SQL', async () => {
  let beginCalls = 0;
  let tagCalls = 0;
  const transaction = ((
    strings: TemplateStringsArray | readonly string[],
    ...values: readonly unknown[]
  ) => {
    tagCalls += 1;
    void strings;
    void values;
    return Promise.resolve([]);
  }) as unknown as postgres.TransactionSql;
  const sql = Object.assign(() => Promise.resolve([]), {
    begin: async (callback: (tx: typeof transaction) => Promise<unknown>) => {
      beginCalls += 1;
      return callback(transaction);
    },
  }) as unknown as postgres.Sql;
  const repository = createPostgresRelationalGraphReadRepository(sql);
  const counts = await repository.countRelations({
    graphNodeId: GRAPH_NODE_ID,
    projectId: PROJECT_ID,
    relationTypes: [],
  });
  assert.deepEqual(counts, {});
  assert.equal(beginCalls, 0);
  assert.equal(tagCalls, 0);
});

test('createReadUnavailableError is identified by read unavailable predicate', () => {
  const error = new GraphReadUnavailableError();
  assert.ok(isReadUnavailableError(error));
  assert.ok(!isReadUnavailableError(new Error('other failure')));
});

test('findRelatedDocuments returns unavailable when related-document SQL rows are malformed', async () => {
  const repository = createReadRepositoryMock([], {
    unsafe() {
      return Promise.resolve([{ documentId: 'doc-1', seedDocumentId: '' }]);
    },
  });
  const result = await repository.findRelatedDocuments({
    projectId: PROJECT_ID,
    relationLimits: { MENTIONS: 5, RELATED_TO: 5, SAME_AS: 5 },
    seedDocumentIds: ['71400000-0000-0000-0000-000000000099'],
  });
  assert.deepEqual(result, { candidates: [], status: 'unavailable' });
});

test('relational graph read adapter accepts only validated project identifiers', async () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresRelationalGraphReadRepository(sql);
  await assert.rejects(
    () => repository.countDocumentNode({ graphNodeId: 'document:issue-714-seed', projectId: '' }),
    /Invalid graph field: projectId/,
  );
  await assert.rejects(
    () =>
      repository.readPreset({
        documentGraphNodeIds: ['document:issue-714-seed'],
        presetId: 'actor-documents' satisfies GraphPresetId,
        projectId: ' ',
      }),
    /Invalid graph field: projectId/,
  );
});
