import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { MemoryObjectStorage } from '../../../packages/storage/src/testing.ts';
import { SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES } from './synthetic-monitor-contract.ts';
import {
  runSyntheticMonitorObservations,
  type SyntheticMonitorRepository,
} from './synthetic-monitor-service.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const reportId = '22222222-2222-4222-8222-222222222222';
const storageUri = 'sample-a/reports/private/report-1.json';

const reportInput = {
  frequency: 'weekly' as const,
  periodStart: '2026-07-07',
  periodEnd: '2026-07-13',
};

const validArtifact = {
  generated_at: '2026-07-14T01:00:00.000Z',
  period: { start: '2026-07-07', end: '2026-07-13' },
  project_id: projectId,
  report_id: reportId,
  schema_version: 'v1',
  sections: [{ id: 'progress', title: 'Progress', markdown: 'All good.' }],
  summary: 'summary',
  title: 'title',
};

for (const [runStatus, expectedStage] of [
  ['pending', 'pending'],
  ['running', 'pending'],
  ['retry_wait', 'pending'],
  ['succeeded', 'ok'],
  ['skipped', 'failed'],
  ['retry_exhausted', 'failed'],
] as const) {
  test(`report periodRun maps ${runStatus} to ${expectedStage}`, async () => {
    const response = await observeReport(
      createMockRepository({
        async lookupPeriodRun() {
          return { status: runStatus, reportId };
        },
      }),
    );
    assert.equal(response.report?.periodRun.status, expectedStage);
    assert.equal(response.report?.periodRun.runStatus, runStatus);
  });
}

test('report periodRun is not_found when no run exists', async () => {
  const response = await observeReport(createMockRepository());
  assert.equal(response.report?.periodRun.status, 'not_found');
  assert.equal(response.report?.periodRun.runStatus, null);
});

test('report artifact is not_found when metadata is missing', async () => {
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return null;
      },
    }),
  );
  assert.equal(response.report?.artifact.status, 'not_found');
  assert.equal(response.report?.artifact.schemaVersion, null);
});

test('report artifact is not_found when object storage is missing', async () => {
  const storage = new MemoryObjectStorage();
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return { schemaVersion: 'v1', storageUri };
      },
    }),
    storage,
  );
  assert.equal(response.report?.artifact.status, 'not_found');
  assert.equal(response.report?.artifact.schemaVersion, 'v1');
  assert.equal(JSON.stringify(response).includes(storageUri), false);
});

test('report artifact fails on schema mismatch', async () => {
  const storage = new MemoryObjectStorage();
  await storage.put(storageUri, JSON.stringify({ ...validArtifact, schema_version: 'v2' }));
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return { schemaVersion: 'v1', storageUri };
      },
    }),
    storage,
  );
  assert.equal(response.report?.artifact.status, 'failed');
});

test('report artifact fails on project_id mismatch', async () => {
  const storage = new MemoryObjectStorage();
  await storage.put(
    storageUri,
    JSON.stringify({ ...validArtifact, project_id: '33333333-3333-4333-8333-333333333333' }),
  );
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return { schemaVersion: 'v1', storageUri };
      },
    }),
    storage,
  );
  assert.equal(response.report?.artifact.status, 'failed');
});

test('report artifact fails on report_id mismatch', async () => {
  const storage = new MemoryObjectStorage();
  await storage.put(
    storageUri,
    JSON.stringify({ ...validArtifact, report_id: '44444444-4444-4444-8444-444444444444' }),
  );
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return { schemaVersion: 'v1', storageUri };
      },
    }),
    storage,
  );
  assert.equal(response.report?.artifact.status, 'failed');
});

test('report artifact fails when stream exceeds the byte limit', async () => {
  const storage = new OversizeStorage(
    storageUri,
    'a'.repeat(SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES + 1),
  );
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return { schemaVersion: 'v1', storageUri };
      },
    }),
    storage,
  );
  assert.equal(response.report?.artifact.status, 'failed');
});

test('report artifact succeeds when metadata and artifact are consistent', async () => {
  const storage = new MemoryObjectStorage();
  await storage.put(storageUri, JSON.stringify(validArtifact));
  const response = await observeReport(
    createMockRepository({
      async lookupPeriodRun() {
        return { status: 'succeeded', reportId };
      },
      async lookupReportMetadata() {
        return { schemaVersion: 'v1', storageUri };
      },
    }),
    storage,
  );
  assert.equal(response.report?.artifact.status, 'ok');
  assert.equal(response.report?.artifact.schemaVersion, 'v1');
  assert.equal(JSON.stringify(response).includes(storageUri), false);
});

class OversizeStorage extends MemoryObjectStorage {
  readonly #uri: string;
  readonly #body: string;

  constructor(uri: string, body: string) {
    super();
    this.#uri = uri;
    this.#body = body;
  }

  override async exists(uri: string): Promise<boolean> {
    return uri === this.#uri;
  }

  override async get(uri: string): Promise<NodeJS.ReadableStream> {
    if (uri !== this.#uri) throw new Error('missing object');
    return Readable.from([Buffer.from(this.#body)]);
  }
}

async function observeReport(
  repository: SyntheticMonitorRepository,
  storage: MemoryObjectStorage = new MemoryObjectStorage(),
) {
  return runSyntheticMonitorObservations({
    allowedProjectSlugs: ['sample-a'],
    repository,
    storage,
    request: {
      projectSlug: 'sample-a',
      sources: [{ kind: 'gmail', threadId: 'thread-1', expectedMessageId: 'message-1' }],
      report: reportInput,
    },
  });
}

function createMockRepository(
  overrides: Partial<SyntheticMonitorRepository> = {},
): SyntheticMonitorRepository {
  return {
    async lookupProject(slug) {
      return slug === 'sample-a'
        ? { id: projectId, slug: 'sample-a', graphName: 'graph_sample_a' }
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
      return { frequency: 'weekly', nextRunAt: '2099-01-01T01:00:00.000Z' };
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
