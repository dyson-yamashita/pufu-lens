import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ObjectInfo, ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { ProjectAccessDeniedError } from './chat.ts';
import { createPufuScoreFromReport } from './pufu-score.ts';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  deletePrivateReport,
  getPrivateReport,
  getPublicReport,
  getPublicReportArtifacts,
  isSafePublicReportLocator,
  listPrivateReports,
  PublicReportNotFoundError,
  parseReportDocumentRow,
  parseReportMetadataRow,
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

function createRepository(): ReportRepository & {
  insertedChunkContents: string[];
  insertedChunks: number;
  storageUri?: string;
} {
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
    insertedChunkContents: [],
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
      this.insertedChunkContents = chunks.map((chunk) => chunk.content);
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
    async deleteReport({ projectId, reportId }) {
      const report = reports.get(reportId);
      if (report && report.projectId === projectId) {
        reports.delete(reportId);
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
assert.equal(generated.report.sections.length, 3);
assert.equal(generated.report.pufu_sources?.length, 2);
assert.equal(generated.report.pufu_sources?.[0]?.title, 'Issue #42 Login failure');
assert.equal(generated.report.title, 'プロジェクト状況レポート 2026-06-01 - 2026-06-07');
assert.match(generated.report.summary, /概況と進行状況/);
assert.deepEqual(
  generated.report.sections.map((section) => section.title),
  ['概況', '進行状況', '課題・次のアクション'],
);
const overviewSection = generated.report.sections.find((section) => section.id === 'activity');
const progressSection = generated.report.sections.find((section) => section.id === 'progress');
const risksSection = generated.report.sections.find((section) => section.id === 'risks');
assert.ok(overviewSection);
assert.ok(progressSection);
assert.ok(risksSection);
assert.doesNotMatch(overviewSection.markdown, /^- /m);
assert.match(overviewSection.markdown, /プロジェクトに関する 2 件の情報が確認できました/);
assert.match(progressSection.markdown, /^- Login failure risk。/m);
assert.match(progressSection.markdown, /^- Merged report UI。/m);
assert.equal(progressSection.sources?.length, 2);
assert.equal(progressSection.sources?.[0]?.title, 'Issue #42 Login failure');
assert.doesNotMatch(progressSection.markdown, /documents|discussion_points|目指す状態/);
assert.match(risksSection.markdown, /Login failure risk.*対応として/);
const oscReport = await createExtractiveReportProvider().generate({
  documents: [
    {
      canonicalUri: 'https://note.example.com/osc-kyoto',
      docType: 'web_page',
      documentId: 'doc-osc-kyoto',
      occurredAt: '2024-08-30T00:00:00.000Z',
      summary:
        'オープンソースカンファレンス@京都にプ譜エディタを出展し、来場者に実際に触れてもらいながら、プ譜の考え方と使い方を紹介しました。',
      title: 'オープンソースカンファレンス@京都にプ譜エディタを出展しました｜Dyson',
    },
  ],
  period: { end: '2024-08-30', start: '2024-08-01' },
  projectSlug: 'pufu-tomonokai',
});
const oscOverview = oscReport.sections.find((section) => section.id === 'activity');
const oscProgress = oscReport.sections.find((section) => section.id === 'progress');
const oscRisks = oscReport.sections.find((section) => section.id === 'risks');
assert.ok(oscOverview);
assert.ok(oscProgress);
assert.ok(oscRisks);
assert.match(oscOverview.markdown, /プ譜エディタを出展/);
assert.match(oscOverview.markdown, /利用者候補にプ譜エディタを見せ/);
assert.match(oscProgress.markdown, /来場者に実際に触れてもらいながら/);
assert.doesNotMatch(
  oscProgress.markdown,
  /^- オープンソースカンファレンス@京都にプ譜エディタを出展しました｜Dyson$/m,
);
assert.match(oscRisks.markdown, /来場者の反応・質問・つまずき/);
assert.match(oscRisks.markdown, /継続利用につながる説明資料や導線/);
const sparseDocumentReport = await createExtractiveReportProvider().generate({
  documents: [
    {
      canonicalUri: 'https://example.com/no-summary',
      docType: 'web_page',
      documentId: 'doc-no-summary',
      occurredAt: '2024-08-30T00:00:00.000Z',
      summary: null,
      title: 'Summary missing source',
    } as never,
    {
      canonicalUri: 'https://example.com/long-summary',
      docType: 'web_page',
      documentId: 'doc-long-summary',
      occurredAt: '2024-08-30T00:00:00.000Z',
      summary: '長い説明'.repeat(80),
      title: 'Long summary source',
    },
  ],
  period: { end: '2024-08-30', start: '2024-08-01' },
  projectSlug: 'pufu-tomonokai',
});
const sparseProgress = sparseDocumentReport.sections.find((section) => section.id === 'progress');
assert.ok(sparseProgress);
assert.doesNotMatch(sparseProgress.markdown, /null|undefined/);
assert.match(sparseProgress.markdown, /Summary missing source。/);
assert.match(sparseProgress.markdown, /…$/m);
assert.doesNotMatch(sparseProgress.markdown, /…。/);
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
assert.equal(repository.insertedChunks, 3);
assert.doesNotMatch(repository.insertedChunkContents.join('\n'), /\n\n\{\}/);
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
const progressReportSection = privateReport.sections.find(
  (section: { readonly id: string }) => section.id === 'progress',
);
assert.ok(progressReportSection?.sources?.[0]);
progressReportSection.sources[0].canonical_uri = 'file:///private/raw/doc-a.json';
progressReportSection.sources[0].snippet = 'PII を含む可能性がある抜粋';
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
validatePublicReportJson({
  ...published.publicReport,
  summary: 'Public host https://172.16.example.com is allowed when it is not an IPv4 address.',
});
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host https://10.0.0.1/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host https://172.16.0.1/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://169.254.169.254/latest must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://[::1]/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://[fd00::1]/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://[fe80::1]/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://127.0.0.2/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://0.0.0.0/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://[::]/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://[::ffff:127.0.0.1]/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);
assert.throws(
  () =>
    validatePublicReportJson({
      ...published.publicReport,
      summary: 'Private host http://[::ffff:10.0.0.1]/path must not be treated as public text.',
    }),
  /Public report contains private text/,
);

const markdownSourceScore = createPufuScoreFromReport({
  period: { end: '2026-06-07', start: '2026-06-01' },
  report_id: 'markdown-source-report',
  sections: [
    {
      id: 'activity',
      markdown: '-  Markdown Source: Parsed without leading spaces',
      metrics: {},
      title: 'Activity',
    },
  ],
  summary: 'summary',
  title: 'title',
});
assert.match(JSON.stringify(markdownSourceScore), /Markdown Source/);
assert.doesNotMatch(JSON.stringify(markdownSourceScore), / {2}Markdown Source/);

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

const deleted = await deletePrivateReport({
  options: { repository, storage },
  projectSlug: 'sample-a',
  reportId: generated.report.report_id,
  userId: 'user-a',
});
assert.equal(deleted.status, 'ok');
await assert.rejects(
  () =>
    getPrivateReport({
      options: { repository, storage },
      projectSlug: 'sample-a',
      reportId: generated.report.report_id,
      userId: 'user-a',
    }),
  ReportNotFoundError,
);

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
assert.throws(
  () =>
    validatePrivateReportJson({
      generated_at: '2026-06-04T00:00:00.000Z',
      period,
      project_id: 'project-a',
      report_id: 'report-invalid-section',
      schema_version: 'v1',
      sections: [
        {
          id: 'unknown',
          markdown: 'body',
          title: 'Unknown',
        },
      ],
      summary: 'summary',
      title: 'title',
    }),
  /Report section id is invalid/,
);

validatePrivateReportJson({
  generated_at: '2026-06-04T00:00:00.000Z',
  period,
  project_id: 'project-a',
  report_id: 'legacy-report',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown: 'legacy overview',
      title: '概況',
    },
    {
      id: 'issues',
      markdown: 'legacy issues',
      title: '論点',
    },
    {
      id: 'progress',
      markdown: '- legacy progress',
      title: '進行状況',
    },
    {
      id: 'risks',
      markdown: '- legacy risks',
      title: '不確実性・リスク',
    },
  ],
  summary: 'summary',
  title: 'title',
});

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

const validReportDocumentRow = {
  canonical_uri: 'https://example.com/issues/42',
  doc_type: 'issue',
  document_id: 'doc-issue',
  occurred_at: '2026-06-03T00:00:00.000Z',
  summary: 'Login failure risk',
  title: 'Issue #42 Login failure',
};

assert.deepEqual(parseReportDocumentRow(validReportDocumentRow), validReportDocumentRow);
assert.deepEqual(parseReportDocumentRow({ ...validReportDocumentRow, occurred_at: null }), {
  ...validReportDocumentRow,
  occurred_at: null,
});
assert.throws(() => parseReportDocumentRow(null), /Invalid report document row/);
assert.throws(
  () => parseReportDocumentRow({ ...validReportDocumentRow, document_id: 123 }),
  /Invalid report document field: document_id/,
);
assert.throws(
  () => parseReportDocumentRow({ ...validReportDocumentRow, doc_type: null }),
  /Invalid report document field: doc_type/,
);
assert.throws(
  () => parseReportDocumentRow({ ...validReportDocumentRow, occurred_at: 123 }),
  /Invalid report document field: occurred_at/,
);

const validReportMetadataRow = {
  created_at: '2026-06-04T00:00:00.000Z',
  id: 'report-a',
  is_public: false,
  period_end: '2026-06-07',
  period_start: '2026-06-01',
  schema_version: 'v1',
  storage_uri: 'sample-a/reports/private/report-a.json',
  summary: 'summary',
  title: 'Weekly report',
};

assert.deepEqual(parseReportMetadataRow(validReportMetadataRow), validReportMetadataRow);
assert.throws(() => parseReportMetadataRow(null), /Invalid report metadata row/);
assert.throws(
  () => parseReportMetadataRow({ ...validReportMetadataRow, is_public: 'false' }),
  /Invalid report metadata field: is_public/,
);
assert.throws(
  () => parseReportMetadataRow({ ...validReportMetadataRow, created_at: {} }),
  /Invalid report metadata field: created_at/,
);
assert.throws(
  () => parseReportMetadataRow({ ...validReportMetadataRow, storage_uri: 123 }),
  /Invalid report metadata field: storage_uri/,
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

const nonObjectGeminiProvider = createGeminiReportProvider({
  apiKey: 'test-key',
  fetchImpl: async () => new Response('null', { status: 200 }),
  model: 'gemini-test',
});
await assert.rejects(
  () =>
    nonObjectGeminiProvider.generate({
      documents: [],
      period,
      projectSlug: 'sample-a',
    }),
  /Gemini report response is not a valid JSON object/,
);

console.log('web report tests passed');
