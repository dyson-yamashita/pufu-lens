import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryObjectStorage } from '../../../packages/storage/src/testing.ts';
import {
  runSyntheticMonitorObservations,
  type SyntheticMonitorRepository,
} from './synthetic-monitor-service.ts';

const project = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'sample-a',
  graphName: 'graph_sample_a',
};

const gmailSource = {
  kind: 'gmail' as const,
  threadId: 'thread-1',
  expectedMessageId: 'message-1',
};

function assertNoSensitivePayload(response: unknown): void {
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    'thread-1',
    'message-1',
    'graph-node-1',
    'storage_uri',
    'database unavailable',
    'postgresql://',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }
}

test('stage observations distinguish raw missing from downstream stages', async () => {
  const response = await observeGmail(
    createMockRepository({
      async lookupRawDocument() {
        return null;
      },
    }),
  );
  assert.equal(response.observations[0]?.raw.status, 'not_found');
  assert.equal(response.observations[0]?.currentDocument.status, 'not_found');
  assert.equal(response.observations[0]?.chunks.status, 'not_found');
  assertNoSensitivePayload(response);
});

test('stage observations mark raw failed without exposing ingest details', async () => {
  const response = await observeGmail(
    createMockRepository({
      async lookupRawDocument() {
        return { id: 'raw-1', ingestStatus: 'failed', sourceVersion: 'message-1' };
      },
    }),
  );
  assert.equal(response.observations[0]?.raw.status, 'failed');
  assert.equal(response.observations[0]?.currentDocument.status, 'not_found');
  assertNoSensitivePayload(response);
});

test('stage observations mark latest version mismatch as currentDocument pending', async () => {
  const response = await observeGmail(
    createMockRepository({
      async lookupRawDocument() {
        return { id: 'raw-1', ingestStatus: 'indexed', sourceVersion: 'message-1' };
      },
      async lookupLatestRawDocument() {
        return { id: 'raw-2', ingestStatus: 'indexed', sourceVersion: 'message-2' };
      },
    }),
  );
  assert.equal(response.observations[0]?.raw.status, 'ok');
  assert.equal(response.observations[0]?.currentDocument.status, 'pending');
  assertNoSensitivePayload(response);
});

test('stage observations mark missing document as currentDocument not_found', async () => {
  const response = await observeGmail(
    createMockRepository({
      async lookupRawDocument() {
        return { id: 'raw-1', ingestStatus: 'indexed', sourceVersion: 'message-1' };
      },
      async lookupLatestRawDocument() {
        return { id: 'raw-1', ingestStatus: 'indexed', sourceVersion: 'message-1' };
      },
      async lookupDocument() {
        return null;
      },
    }),
  );
  assert.equal(response.observations[0]?.currentDocument.status, 'not_found');
  assert.equal(response.observations[0]?.chunks.status, 'not_found');
  assertNoSensitivePayload(response);
});

test('stage observations mark zero chunks as pending', async () => {
  const response = await observeGmail(
    createMockRepository({
      async countDocumentChunks() {
        return { total: 0, withEmbedding: 0 };
      },
    }),
  );
  assert.equal(response.observations[0]?.chunks.status, 'pending');
  assert.equal(response.observations[0]?.chunks.embeddingComplete, false);
  assertNoSensitivePayload(response);
});

test('stage observations mark partial embeddings as pending', async () => {
  const response = await observeGmail(
    createMockRepository({
      async countDocumentChunks() {
        return { total: 2, withEmbedding: 1 };
      },
    }),
  );
  assert.equal(response.observations[0]?.chunks.status, 'pending');
  assert.equal(response.observations[0]?.chunks.embeddingComplete, false);
  assertNoSensitivePayload(response);
});

test('stage observations mark missing graphNodeId as graph not_found', async () => {
  const response = await observeGmail(
    createMockRepository({
      async lookupDocument() {
        return { id: 'doc-1', rawDocumentId: 'raw-1', graphNodeId: null };
      },
    }),
  );
  assert.equal(response.observations[0]?.graph.status, 'not_found');
  assert.equal(response.observations[0]?.graph.documentNodePresent, false);
  assertNoSensitivePayload(response);
});

test('stage observations mark missing AGE node as graph not_found', async () => {
  const response = await observeGmail(
    createMockRepository({
      async countGraphDocumentNode() {
        return 0;
      },
    }),
  );
  assert.equal(response.observations[0]?.graph.status, 'not_found');
  assert.equal(response.observations[0]?.graph.documentNodePresent, false);
  assertNoSensitivePayload(response);
});

test('stage observations mark insufficient expected relations as graph failed', async () => {
  const response = await observeGmail(
    createMockRepository({
      async countGraphRelations() {
        return { SENT: 0 };
      },
    }),
    {
      ...gmailSource,
      expectedRelations: [{ type: 'SENT', minCount: 1 }],
    },
  );
  assert.equal(response.observations[0]?.graph.status, 'failed');
  assert.equal(response.observations[0]?.graph.documentNodePresent, true);
  assertNoSensitivePayload(response);
});

test('stage observations report full success across raw document chunk and graph', async () => {
  const response = await observeGmail(
    createMockRepository({
      async countGraphRelations() {
        return { SENT: 2 };
      },
    }),
    {
      ...gmailSource,
      expectedRelations: [{ type: 'SENT', minCount: 1 }],
    },
  );
  assert.equal(response.observations[0]?.raw.status, 'ok');
  assert.equal(response.observations[0]?.currentDocument.status, 'ok');
  assert.equal(response.observations[0]?.chunks.status, 'ok');
  assert.equal(response.observations[0]?.chunks.embeddingComplete, true);
  assert.equal(response.observations[0]?.graph.status, 'ok');
  assert.equal(response.observations[0]?.graph.documentNodePresent, true);
  assertNoSensitivePayload(response);
});

async function observeGmail(
  repository: SyntheticMonitorRepository,
  source: typeof gmailSource & {
    expectedRelations?: { type: 'SENT'; minCount: number }[];
  } = gmailSource,
) {
  return runSyntheticMonitorObservations({
    allowedProjectSlugs: ['sample-a'],
    repository,
    storage: new MemoryObjectStorage(),
    request: { projectSlug: 'sample-a', sources: [source] },
  });
}

function createMockRepository(
  overrides: Partial<SyntheticMonitorRepository> = {},
): SyntheticMonitorRepository {
  return {
    async lookupProject(slug) {
      return slug === project.slug ? project : null;
    },
    async lookupRawDocument(input) {
      if (input.logicalSourceId === 'thread-1' && input.sourceVersion === 'message-1') {
        return { id: 'raw-1', ingestStatus: 'indexed', sourceVersion: 'message-1' };
      }
      return null;
    },
    async lookupLatestRawDocument(input) {
      if (input.logicalSourceId === 'thread-1') {
        return { id: 'raw-1', ingestStatus: 'indexed', sourceVersion: 'message-1' };
      }
      return null;
    },
    async lookupDocument(input) {
      if (input.logicalSourceId === 'thread-1') {
        return { id: 'doc-1', rawDocumentId: 'raw-1', graphNodeId: 'graph-node-1' };
      }
      return null;
    },
    async countDocumentChunks() {
      return { total: 2, withEmbedding: 2 };
    },
    async countGraphDocumentNode() {
      return 1;
    },
    async countGraphRelations() {
      return { SENT: 1 };
    },
    async lookupSchedulesForLogicalSource() {
      return [
        {
          enabled: true,
          retryCount: 0,
          leaseExpiresAt: null,
          nextRunAt: '2099-01-01T01:00:00.000Z',
        },
      ];
    },
    async lookupReportSchedule() {
      return null;
    },
    async lookupPeriodRun() {
      return null;
    },
    async lookupReportMetadata() {
      return null;
    },
    ...overrides,
  };
}
