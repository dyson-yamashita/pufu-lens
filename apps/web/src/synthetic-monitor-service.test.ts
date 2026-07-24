import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryObjectStorage } from '../../../packages/storage/src/testing.ts';
import {
  runSyntheticMonitorObservations,
  type SyntheticMonitorRepository,
} from './synthetic-monitor-service.ts';

test('runSyntheticMonitorObservations returns partial per-source stages without echoing identifiers', async () => {
  const repository = createMockRepository();
  const storage = new MemoryObjectStorage();
  await storage.put(
    'sample-a/reports/private/report-1.json',
    JSON.stringify({
      generated_at: '2026-07-14T01:00:00.000Z',
      period: { start: '2026-07-07', end: '2026-07-13' },
      project_id: '11111111-1111-4111-8111-111111111111',
      report_id: '22222222-2222-4222-8222-222222222222',
      schema_version: 'v1',
      sections: [
        {
          id: 'progress',
          title: 'Progress',
          markdown: 'All good.',
        },
      ],
      summary: 'summary',
      title: 'title',
    }),
  );
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['sample-a'],
    repository,
    storage,
    request: {
      projectSlug: 'sample-a',
      sources: [
        {
          kind: 'gmail',
          threadId: 'thread-1',
          expectedMessageId: 'message-1',
          expectedRelations: [{ type: 'SENT', minCount: 1 }],
        },
        {
          kind: 'web',
          canonicalUrl: 'https://example.com/missing',
          expectedContentHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        },
      ],
      report: {
        frequency: 'weekly',
        periodStart: '2026-07-07',
        periodEnd: '2026-07-13',
      },
    },
  });
  assert.equal(response.contractVersion, 'synthetic-monitor-v1');
  assert.equal(response.projectSlug, 'sample-a');
  assert.equal(response.observations[0]?.kind, 'gmail');
  assert.equal(response.observations[0]?.raw.status, 'ok');
  assert.equal(response.observations[0]?.graph.status, 'failed');
  assert.equal(response.observations[1]?.raw.status, 'not_found');
  assert.equal(response.report?.periodRun.status, 'ok');
  assert.equal(response.report?.artifact.status, 'ok');
  assert.equal(JSON.stringify(response).includes('thread-1'), false);
  assert.equal(JSON.stringify(response).includes('storage_uri'), false);
});

test('runSyntheticMonitorObservations keeps other sources when one repository call throws', async () => {
  const repository = createMockRepository({
    async lookupRawDocument(input) {
      if (input.logicalSourceId === 'thread-broken') {
        throw new Error('database unavailable');
      }
      if (input.logicalSourceId === 'thread-1' && input.sourceVersion === 'message-1') {
        return { id: 'raw-1', ingestStatus: 'indexed', sourceVersion: 'message-1' };
      }
      return null;
    },
  });
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['sample-a'],
    repository,
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'sample-a',
      sources: [
        { kind: 'gmail', threadId: 'thread-1', expectedMessageId: 'message-1' },
        { kind: 'gmail', threadId: 'thread-broken', expectedMessageId: 'message-2' },
      ],
    },
  });
  assert.equal(response.observations[0]?.raw.status, 'ok');
  assert.equal(response.observations[1]?.raw.status, 'failed');
  assert.equal(response.observations[1]?.graph.status, 'failed');
  assert.equal(JSON.stringify(response).includes('database unavailable'), false);
});

test('runSyntheticMonitorObservations keeps source observations when report observation throws', async () => {
  const repository = createMockRepository({
    async lookupReportSchedule() {
      throw new Error('report schedule query failed');
    },
  });
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['sample-a'],
    repository,
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'sample-a',
      sources: [{ kind: 'gmail', threadId: 'thread-1', expectedMessageId: 'message-1' }],
      report: {
        frequency: 'weekly',
        periodStart: '2026-07-07',
        periodEnd: '2026-07-13',
      },
    },
  });
  assert.equal(response.observations[0]?.raw.status, 'ok');
  assert.equal(response.report?.schedule.status, 'failed');
  assert.equal(response.report?.periodRun.status, 'failed');
  assert.equal(response.report?.artifact.status, 'failed');
});

test('runSyntheticMonitorObservations denies projects outside dedicated allowlist', async () => {
  await assert.rejects(
    () =>
      runSyntheticMonitorObservations({
        allowedProjectSlugs: ['sample-b'],
        repository: createMockRepository(),
        storage: new MemoryObjectStorage(),
        request: {
          projectSlug: 'sample-a',
          sources: [{ kind: 'gmail', threadId: 'thread-1', expectedMessageId: 'message-1' }],
        },
      }),
    /monitor project scope denied/,
  );
});

function createMockRepository(
  overrides: Partial<SyntheticMonitorRepository> = {},
): SyntheticMonitorRepository {
  return {
    async lookupProject(slug) {
      return slug === 'sample-a'
        ? {
            id: '11111111-1111-4111-8111-111111111111',
            slug: 'sample-a',
            graphName: 'graph_sample_a',
          }
        : null;
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
      return { SENT: 0 };
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
      return { frequency: 'weekly', nextRunAt: '2026-07-20T01:00:00.000Z' };
    },
    async lookupPeriodRun() {
      return {
        status: 'succeeded',
        reportId: '22222222-2222-4222-8222-222222222222',
      };
    },
    async lookupReportMetadata() {
      return {
        schemaVersion: 'v1',
        storageUri: 'sample-a/reports/private/report-1.json',
      };
    },
    ...overrides,
  };
}
