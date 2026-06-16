import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ObjectInfo, ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { ProjectAccessDeniedError } from './chat.ts';
import { createPufuScoreFromReport } from './pufu-score.ts';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  getPrivateReport,
  getPublicReport,
  getPublicReportArtifacts,
  isSafePublicReportLocator,
  listPrivateReports,
  PublicReportNotFoundError,
  parseReportProjectLookupRow,
  publishPublicReport,
  ReportNotFoundError,
  type ReportRepository,
  readPublicReportManifest,
  resolveReportPeriod,
  revokePublicReport,
  runGenerateReport,
  validatePrivateReportJson,
  validatePublicContextBundle,
  validatePublicReportJson,
  writePublicProjectManifest,
} from './report.ts';

class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, string>();

  async put(uri: string, body: Buffer | NodeJS.ReadableStream | string): Promise<{ uri: string }> {
    const text =
      typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : '';
    const storedUri = `file:///tmp/pufu-lens/${uri}`;
    this.objects.set(storedUri, text);
    this.objects.set(uri, text);
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
    return this.objects.has(uri) || this.objects.has(`file:///tmp/pufu-lens/${uri}`);
  }

  async *list(): AsyncIterable<ObjectInfo> {}
}

function createRepository(): ReportRepository & { insertedChunks: number; storageUri?: string } {
  const reports = new Map<
    string,
    { isPublic: boolean; projectId: string; storageUri: string; title: string }
  >([
    [
      'project-b-report',
      {
        isPublic: false,
        projectId: 'project-b',
        storageUri: 'project-b/reports/private/project-b-report.json',
        title: 'Project B report',
      },
    ],
  ]);
  return {
    insertedChunks: 0,
    async lookupProjectMember({ projectSlug, userId }) {
      if (projectSlug === 'sample-a' && userId === 'user-a') {
        return { id: 'project-a', slug: 'sample-a', visibility: 'public' };
      }
      if (projectSlug === 'sample-b' && userId === 'user-b') {
        return { id: 'project-b', slug: 'sample-b', visibility: 'private' };
      }
      return undefined;
    },
    async lookupProject({ projectSlug }) {
      return projectSlug === 'sample-a'
        ? { id: 'project-a', slug: 'sample-a', visibility: 'public' }
        : undefined;
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
      reports.set(report.report_id, {
        isPublic: false,
        projectId: report.project_id,
        storageUri,
        title: report.title,
      });
    },
    async listReports({ projectId }) {
      return [...reports.entries()]
        .filter(([, report]) => report.projectId === projectId)
        .map(([id, report]) => ({
          createdAt: '2026-06-04T00:00:00.000Z',
          id,
          isPublic: report.isPublic,
          period: { end: '2026-06-07', start: '2026-06-01' },
          schemaVersion: 'v1',
          storageUri: report.storageUri,
          summary: 'summary',
          title: report.title,
        }));
    },
    async readReportMetadata({ projectId, reportId }) {
      const report = reports.get(reportId);
      return report && report.projectId === projectId
        ? {
            createdAt: '2026-06-04T00:00:00.000Z',
            id: reportId,
            isPublic: report.isPublic,
            period: { end: '2026-06-07', start: '2026-06-01' },
            schemaVersion: 'v1',
            storageUri: report.storageUri,
            summary: 'summary',
            title: report.title,
          }
        : undefined;
    },
    async setReportPublicState({ isPublic, reportId }) {
      const report = reports.get(reportId);
      if (report) {
        reports.set(reportId, { ...report, isPublic });
      }
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
assert.equal(generated.report.pufu_sources?.length, 2);
assert.equal(generated.report.pufu_sources?.[0]?.title, 'Issue #42 Login failure');
assert.equal(generated.report.title, 'プロジェクト状況レポート 2026-06-01 - 2026-06-07');
assert.match(generated.report.summary, /概況と進行状況/);
assert.deepEqual(
  generated.report.sections.map((section) => section.title),
  ['概況', '論点', '進行状況', '不確実性・リスク'],
);
const overviewSection = generated.report.sections.find((section) => section.id === 'activity');
const progressSection = generated.report.sections.find((section) => section.id === 'progress');
assert.ok(overviewSection);
assert.ok(progressSection);
assert.match(overviewSection.markdown, /プロジェクトは次の文脈で動いています/);
assert.match(progressSection.markdown, /目指す状態に近づいているか/);
const pufuScore = createPufuScoreFromReport({
  ...generated.report,
  pufu_sources: [
    {
      canonical_uri: 'https://note.example.com/osc-osaka',
      doc_type: 'web_page',
      document_id: 'doc-osc',
      occurred_at: '2026-01-31T15:24:00.000Z',
      snippet:
        '昨年に引き続き、オープンソースカンファレンス＠大阪に「プ譜友の会」からプ譜エディターを出展しました。',
      title: '【プ譜友の会】オープンソースカンファレンス2026＠大阪の出展レポート',
    },
  ],
});
assert.match(pufuScore.gainingGoal.text, /プ譜エディターを試す人を増やす/);
assert.match(pufuScore.elements.environment.text, /来場者/);
assert.match(pufuScore.purposes[0]?.measures[0]?.text ?? '', /ブース/);
assert.doesNotMatch(JSON.stringify(pufuScore), /データソースから|根拠資料/);
assert.equal(repository.insertedChunks, 4);
assert.ok(repository.storageUri?.includes('/sample-a/reports/private/'));
validatePrivateReportJson(JSON.parse(await storage.getText(generated.storageUri)));
const generatedMetadata = await repository.readReportMetadata({
  projectId: 'project-a',
  reportId: generated.report.report_id,
});
assert.equal(generatedMetadata?.isPublic, true);
assert.ok(
  await storage.exists(`sample-a/reports/public/${generated.report.report_id}/manifest.json`),
);
assert.ok(await storage.exists('sample-a/project-public-state.json'));

const explicitPeriodRepository = createRepository();
let providerPeriod: { readonly end: string; readonly start: string } | undefined;
const explicitPeriodReport = await runGenerateReport({
  options: {
    period: { end: '2026-05-07', start: '2026-05-01' },
    provider: {
      async generate({ documents, period }) {
        providerPeriod = period;
        assert.equal(documents.length, 2);
        return createExtractiveReportProvider().generate({
          documents,
          period,
          projectSlug: 'sample-a',
        });
      },
    },
    repository: {
      ...explicitPeriodRepository,
      async listRecentDocuments({ period, projectId }) {
        assert.equal(projectId, 'project-a');
        assert.deepEqual(period, { end: '2026-05-07', start: '2026-05-01' });
        return [
          {
            canonicalUri: 'https://example.com/may-a',
            docType: 'web_page',
            documentId: 'doc-may-a',
            occurredAt: '2026-05-07T00:00:00.000Z',
            summary: 'May report source A',
            title: 'May Source A',
          },
          {
            canonicalUri: 'https://example.com/may-b',
            docType: 'web_page',
            documentId: 'doc-may-b',
            occurredAt: '2026-05-01T00:00:00.000Z',
            summary: 'May report source B',
            title: 'May Source B',
          },
        ];
      },
    },
    storage: new MemoryStorage(),
  },
  projectSlug: 'sample-a',
});
assert.deepEqual(providerPeriod, { end: '2026-05-07', start: '2026-05-01' });
assert.deepEqual(explicitPeriodReport.report.period, { end: '2026-05-07', start: '2026-05-01' });
assert.equal(explicitPeriodReport.report.pufu_sources?.length, 2);

const sampleAReports = await listPrivateReports({
  options: { repository },
  projectSlug: 'sample-a',
  userId: 'user-a',
});
assert.equal(sampleAReports.status, 'ok');
assert.deepEqual(
  sampleAReports.reports.map((report) => report.id),
  [generated.report.report_id],
);
await assert.rejects(
  () =>
    getPrivateReport({
      options: { repository, storage },
      projectSlug: 'sample-a',
      reportId: 'project-b-report',
      userId: 'user-a',
    }),
  ReportNotFoundError,
);

const privateReport = JSON.parse(await storage.getText(generated.storageUri));
privateReport.summary = '公開前の概要 contact@example.com https://internal.example.com/roadmap';
privateReport.sections[0].markdown =
  '社内 URL https://corp.example.com/doc と user@example.com を含む';
privateReport.sections[0].sources[0].canonical_uri = 'file:///private/raw/doc-a.json';
privateReport.sections[0].sources[0].snippet = 'PII を含む可能性がある抜粋';
await storage.put(generated.storageUri, `${JSON.stringify(privateReport, null, 2)}\n`);

const published = await publishPublicReport({
  now: new Date('2026-06-04T13:00:00.000Z'),
  options: { repository, storage },
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  userId: 'user-a',
});
assert.equal(published.status, 'ok');
assert.equal(published.publicReport.schema_version, 'public-v1');
assert.equal(published.manifest.revoked_at, null);
assert.match(published.manifest.public_report_uri, /report\.json/);
assert.ok(
  await storage.exists(`sample-a/reports/public/${generated.report.report_id}/manifest.json`),
);
validatePublicReportJson(published.publicReport);
const publicText = JSON.stringify(published.publicReport);
assert.doesNotMatch(
  publicText,
  /project-a|doc-issue|doc-pr|doc-a|contact@example\.com|user@example\.com|internal|corp|file:\/\//,
);
assert.match(publicText, /public_source_id/);
validatePublicReportJson({
  ...published.publicReport,
  summary: 'Public host https://10.example.com is allowed when it is not a private IP.',
});

const publicDetail = await getPublicReport({
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  storage,
});
assert.equal(publicDetail.status, 'ok');
assert.equal(publicDetail.report.report_id, generated.report.report_id);
const publicArtifacts = await getPublicReportArtifacts({
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  storage,
});
assert.equal(publicArtifacts.contextBundle.schema_version, 'public-context-v1');
assert.equal(publicArtifacts.contextBundle.report_id, generated.report.report_id);
validatePublicContextBundle(publicArtifacts.contextBundle, publicArtifacts.report);

assert.equal(isSafePublicReportLocator({ projectSlug: 'sample-a', reportId: 'report-a' }), true);
assert.equal(
  isSafePublicReportLocator({ projectSlug: '../sample-a', reportId: 'report-a' }),
  false,
);
assert.equal(
  isSafePublicReportLocator({ projectSlug: 'sample-a', reportId: '../report-a' }),
  false,
);
assert.equal(
  await readPublicReportManifest({
    projectSlug: '../sample-a',
    reportId: generated.report.report_id,
    storage,
  }),
  undefined,
);

const gsReportUri = `gs://pufu-lens-public/sample-a/reports/public/${generated.report.report_id}/${published.manifest.artifact_version}/report.json`;
const gsContextUri = `gs://pufu-lens-public/sample-a/reports/public/${generated.report.report_id}/${published.manifest.artifact_version}/context-bundle.json`;
const gsStorage = new MemoryStorage();
gsStorage.objects.set(gsReportUri, JSON.stringify(published.publicReport));
gsStorage.objects.set(
  gsContextUri,
  JSON.stringify({
    report_id: published.publicReport.report_id,
    schema_version: 'public-context-v1',
    sections: published.publicReport.sections.map((section) => ({
      id: section.id,
      markdown: section.markdown,
      public_source_ids: section.sources?.map((source) => source.public_source_id) ?? [],
      title: section.title,
    })),
  }),
);
gsStorage.objects.set(
  `sample-a/project-public-state.json`,
  JSON.stringify({
    project_slug: 'sample-a',
    published_at: '2026-06-04T13:00:00.000Z',
    schema_version: 'public-project-manifest-v1',
    visibility: 'public',
  }),
);
gsStorage.objects.set(
  `sample-a/reports/public/${generated.report.report_id}/manifest.json`,
  JSON.stringify({
    ...published.manifest,
    etag: createHash('sha256').update(JSON.stringify(published.publicReport)).digest('hex'),
    public_context_bundle_uri: gsContextUri,
    public_report_uri: gsReportUri,
  }),
);
const gsPublicDetail = await getPublicReport({
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  storage: gsStorage,
});
assert.equal(gsPublicDetail.status, 'ok');

await writePublicProjectManifest({
  projectSlug: 'sample-a',
  storage,
  visibility: 'private',
});
await assert.rejects(
  () =>
    getPublicReport({
      projectSlug: 'sample-a',
      reportId: generated.report.report_id,
      storage,
    }),
  PublicReportNotFoundError,
);
await writePublicProjectManifest({
  projectSlug: 'sample-a',
  storage,
  visibility: 'public',
});

const revoked = await revokePublicReport({
  now: new Date('2026-06-04T14:00:00.000Z'),
  options: { repository, storage },
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  userId: 'user-a',
});
assert.equal(revoked.status, 'ok');
assert.equal(typeof revoked.manifest.revoked_at, 'string');
await assert.rejects(
  () =>
    getPublicReport({
      projectSlug: 'sample-a',
      reportId: generated.report.report_id,
      storage,
    }),
  PublicReportNotFoundError,
);

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

assert.deepEqual(
  parseReportProjectLookupRow({ id: 'proj-1', slug: 'sample-a', visibility: 'public' }),
  {
    id: 'proj-1',
    slug: 'sample-a',
    visibility: 'public',
  },
);

assert.throws(
  () => parseReportProjectLookupRow({ id: 'proj-1', slug: 'sample-a', visibility: 'internal' }),
  /Invalid project lookup field: visibility/,
);
assert.throws(
  () => parseReportProjectLookupRow({ slug: 'sample-a', visibility: 'public' }),
  /Invalid project lookup field: id/,
);
assert.throws(
  () => parseReportProjectLookupRow({ id: 'proj-1', visibility: 'public' }),
  /Invalid project lookup field: slug/,
);

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
