import assert from 'node:assert/strict';
import type { ObjectInfo, ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { ProjectAccessDeniedError } from './chat.ts';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  getPrivateReport,
  listPrivateReports,
  ReportNotFoundError,
  type ReportRepository,
  resolveReportPeriod,
  runGenerateReport,
  validatePrivateReportJson,
} from './report.ts';

class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, string>();

  async put(uri: string, body: Buffer | NodeJS.ReadableStream | string): Promise<{ uri: string }> {
    const text =
      typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
    const storedUri = `file:///tmp/pufu-lens/${uri}`;
    this.objects.set(storedUri, text);
    return { uri: storedUri };
  }

  async get(): Promise<NodeJS.ReadableStream> {
    throw new Error('not implemented');
  }

  async getText(uri: string): Promise<string> {
    const value = this.objects.get(uri);
    if (!value) {
      throw new Error(`missing object: ${uri}`);
    }
    return value;
  }

  async exists(uri: string): Promise<boolean> {
    return this.objects.has(uri);
  }

  async *list(): AsyncIterable<ObjectInfo> {}
}

function createRepository(): ReportRepository & { insertedChunks: number; storageUri?: string } {
  const reports = new Map<string, { storageUri: string; title: string }>();
  return {
    insertedChunks: 0,
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && userId === 'user-a'
        ? { id: 'project-a', slug: 'sample-a' }
        : undefined;
    },
    async lookupProject({ projectSlug }) {
      return projectSlug === 'sample-a' ? { id: 'project-a', slug: 'sample-a' } : undefined;
    },
    async listRecentDocuments({ projectId }) {
      assert.equal(projectId, 'project-a');
      return [
        {
          canonicalUri: 'https://example.com/issues/42',
          docType: 'issue',
          documentId: 'doc-issue',
          occurredAt: '2026-06-03T00:00:00.000Z',
          summary: 'Login failure risk',
          title: 'Issue #42 Login failure',
        },
        {
          canonicalUri: 'https://example.com/pulls/7',
          docType: 'pull_request',
          documentId: 'doc-pr',
          occurredAt: '2026-06-02T00:00:00.000Z',
          summary: 'Merged report UI',
          title: 'PR #7 Report UI',
        },
      ];
    },
    async insertReport({ chunks, report, storageUri }) {
      this.insertedChunks = chunks.length;
      this.storageUri = storageUri;
      reports.set(report.report_id, { storageUri, title: report.title });
    },
    async listReports() {
      return [...reports.entries()].map(([id, report]) => ({
        createdAt: '2026-06-04T00:00:00.000Z',
        id,
        isPublic: false,
        period: { end: '2026-06-07', start: '2026-06-01' },
        schemaVersion: 'v1',
        storageUri: report.storageUri,
        summary: 'summary',
        title: report.title,
      }));
    },
    async readReportMetadata({ reportId }) {
      const report = reports.get(reportId);
      return report
        ? {
            createdAt: '2026-06-04T00:00:00.000Z',
            id: reportId,
            isPublic: false,
            period: { end: '2026-06-07', start: '2026-06-01' },
            schemaVersion: 'v1',
            storageUri: report.storageUri,
            summary: 'summary',
            title: report.title,
          }
        : undefined;
    },
  };
}

const period = resolveReportPeriod(new Date('2026-06-04T12:00:00.000Z'), 'weekly');
assert.deepEqual(period, { end: '2026-06-07', start: '2026-06-01' });

const repository = createRepository();
const storage = new MemoryStorage();
const generated = await runGenerateReport({
  options: {
    now: new Date('2026-06-04T12:00:00.000Z'),
    provider: createExtractiveReportProvider(),
    repository,
    storage,
  },
  projectSlug: 'sample-a',
});
assert.equal(generated.report.schema_version, 'v1');
assert.equal(generated.report.sections.length, 4);
assert.equal(repository.insertedChunks, 4);
assert.ok(repository.storageUri?.includes('/sample-a/reports/private/'));
validatePrivateReportJson(JSON.parse(await storage.getText(generated.storageUri)));

const reports = await listPrivateReports({
  options: { repository },
  projectSlug: 'sample-a',
  userId: 'user-a',
});
assert.equal(reports.status, 'ok');
assert.equal(reports.reports.length, 1);

const detail = await getPrivateReport({
  options: { repository, storage },
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  userId: 'user-a',
});
assert.equal(detail.status, 'ok');
assert.equal(detail.report?.report_id, generated.report.report_id);

const outsideHours = await listPrivateReports({
  options: {
    businessHours: { enabled: true, endHour: 18, startHour: 9, timeZone: 'Asia/Tokyo' },
    now: new Date('2026-06-07T12:00:00+09:00'),
    repository,
  },
  projectSlug: 'sample-a',
  userId: 'user-a',
});
assert.equal(outsideHours.status, 'db_outside_business_hours');

await assert.rejects(
  () =>
    listPrivateReports({
      options: { repository },
      projectSlug: 'sample-a',
      userId: 'user-b',
    }),
  ProjectAccessDeniedError,
);

await assert.rejects(
  () =>
    getPrivateReport({
      options: { repository, storage },
      projectSlug: 'sample-a',
      reportId: 'missing',
      userId: 'user-a',
    }),
  ReportNotFoundError,
);

assert.throws(() => validatePrivateReportJson({ schema_version: 'v2' }), /schema_version/);

const malformedGeminiProvider = createGeminiReportProvider({
  apiKey: 'test-key',
  fetchImpl: async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"title":"broken"' }] } }],
      }),
      { status: 200 },
    ),
  model: 'gemini-test',
});
await assert.rejects(
  () =>
    malformedGeminiProvider.generate({
      documents: [],
      period,
      projectSlug: 'sample-a',
    }),
  /Failed to parse Gemini report response as JSON/,
);

console.log('web report tests passed');
