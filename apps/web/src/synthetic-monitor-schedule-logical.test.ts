import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryObjectStorage } from '../../../packages/storage/src/testing.ts';
import {
  runSyntheticMonitorObservations,
  type SyntheticMonitorRepository,
} from './synthetic-monitor-service.ts';

test('schedule observation follows logical source identity when expected raw version is missing', async () => {
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['sample-a'],
    repository: createMockRepository({
      async lookupRawDocument() {
        return null;
      },
      async lookupSchedulesForLogicalSource(input) {
        if (input.logicalSourceId === 'thread-1' && input.sourceType === 'gmail') {
          return [
            {
              enabled: true,
              retryCount: 0,
              leaseExpiresAt: null,
              nextRunAt: '2099-01-01T01:00:00.000Z',
            },
          ];
        }
        return [];
      },
    }),
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'sample-a',
      sources: [{ kind: 'gmail', threadId: 'thread-1', expectedMessageId: 'message-new' }],
    },
  });
  assert.equal(response.observations[0]?.raw.status, 'not_found');
  assert.equal(response.observations[0]?.schedule?.status, 'ok');
  assert.equal(response.observations[0]?.schedule?.enabled, true);
  assert.equal(response.observations[0]?.schedule?.nextRunDue, false);
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
    async lookupRawDocument() {
      return null;
    },
    async lookupLatestRawDocument() {
      return null;
    },
    async lookupDocument() {
      return null;
    },
    async countDocumentChunks() {
      return { total: 0, withEmbedding: 0 };
    },
    async countGraphDocumentNode() {
      return 0;
    },
    async countGraphRelations() {
      return {};
    },
    async lookupSchedulesForLogicalSource() {
      return [];
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
