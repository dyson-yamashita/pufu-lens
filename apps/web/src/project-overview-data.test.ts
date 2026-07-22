import assert from 'node:assert/strict';
import { MemoryObjectStorage } from '@pufu-lens/storage/testing';
import {
  buildProjectOverviewPufuReportKey,
  loadLatestProjectOverview,
} from './project-overview-data.ts';
import { PROJECT_OVERVIEW_SCHEMA_VERSION } from './report-project-overview.ts';
import type { ReportListItem, ReportRepository } from './report-repository.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const scheduledMetadata: ReportListItem = {
  createdAt: '2026-06-04T00:00:00.000Z',
  generationKind: 'scheduled',
  id: 'report-scheduled',
  isPublic: false,
  period: { end: '2026-06-07', start: '2026-06-01' },
  previousScheduledReportId: null,
  scheduleFrequency: 'weekly',
  schedulePeriodRunId: 'run-a',
  schemaVersion: 'v1',
  storageUri: 'sample-a/reports/private/report-scheduled.json',
  summary: 'summary',
  title: 'Scheduled report',
};

const scheduledReport: PrivateReportJsonV1 = {
  generated_at: '2026-06-04T00:00:00.000Z',
  period: { end: '2026-06-07', start: '2026-06-01' },
  project_id: 'project-a',
  project_overview: {
    assets: [{ description: 'デモ導線を整備した。', title: 'デモ導線' }],
    issues: [
      {
        description: '初見向け説明が長い。',
        next_action: '説明の短文化',
        title: '説明負荷',
      },
    ],
    schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
    status_summary: '出展準備と改善が並行して進んだ。',
  },
  report_id: 'report-scheduled',
  schema_version: 'v1',
  sections: [{ id: 'activity', markdown: '概況', title: '概況' }],
  summary: 'summary',
  title: 'Scheduled report',
};

const overviewPufuKey = buildProjectOverviewPufuReportKey({
  period: scheduledReport.period,
  projectSlug: 'sample-a',
});

const storage = new MemoryObjectStorage();
await storage.put(scheduledMetadata.storageUri, `${JSON.stringify(scheduledReport, null, 2)}\n`);

const repository: ReportRepository = {
  async insertReport() {
    return undefined;
  },
  async listRecentDocuments() {
    return [];
  },
  async listReports() {
    return [scheduledMetadata];
  },
  async lookupProject() {
    return { graphName: null, id: 'project-a', slug: 'sample-a', visibility: 'public' };
  },
  async lookupProjectMember() {
    return undefined;
  },
  async readLatestScheduledReport() {
    return scheduledMetadata;
  },
  async readReportMetadata({ reportId }) {
    return reportId === scheduledMetadata.id ? scheduledMetadata : undefined;
  },
  async deleteReport() {},
};

const memberView = await loadLatestProjectOverview({
  isMember: true,
  projectId: 'project-a',
  projectSlug: 'sample-a',
  repository,
  storage,
});
assert.equal(memberView.kind, 'ready');
if (memberView.kind === 'ready') {
  assert.equal(memberView.snapshot.showReportLink, true);
  assert.equal(memberView.snapshot.reportHref, '/projects/sample-a/reports/report-scheduled');
  assert.equal(memberView.snapshot.pufuInput.report_id, overviewPufuKey);
  const serialized = JSON.stringify(memberView.snapshot);
  assert.match(serialized, /report-scheduled/);
  assert.doesNotMatch(
    JSON.stringify(memberView.snapshot.pufuInput),
    /document_id|canonical_uri|storage_uri|"items"|"metrics"|"sources"|report-scheduled/,
  );
}

const anonymousView = await loadLatestProjectOverview({
  isMember: false,
  projectId: 'project-a',
  projectSlug: 'sample-a',
  repository,
  storage,
});
assert.equal(anonymousView.kind, 'ready');
if (anonymousView.kind === 'ready') {
  assert.equal(anonymousView.snapshot.showReportLink, false);
  assert.equal(anonymousView.snapshot.reportHref, null);
  const serialized = JSON.stringify(anonymousView.snapshot);
  assert.doesNotMatch(serialized, /report-scheduled/);
  assert.equal(anonymousView.snapshot.pufuInput.report_id, overviewPufuKey);
}

const publicMetadata = { ...scheduledMetadata, isPublic: true };
const publicRepository: ReportRepository = {
  ...repository,
  async readLatestScheduledReport() {
    return publicMetadata;
  },
};
const anonymousPublicView = await loadLatestProjectOverview({
  isMember: false,
  projectId: 'project-a',
  projectSlug: 'sample-a',
  repository: publicRepository,
  storage,
});
assert.equal(anonymousPublicView.kind, 'ready');
if (anonymousPublicView.kind === 'ready') {
  assert.equal(anonymousPublicView.snapshot.showReportLink, true);
  assert.equal(
    anonymousPublicView.snapshot.reportHref,
    '/reports/public/sample-a/report-scheduled',
  );
  const serialized = JSON.stringify(anonymousPublicView.snapshot);
  assert.match(serialized, /report-scheduled/);
  assert.doesNotMatch(JSON.stringify(anonymousPublicView.snapshot.pufuInput), /report-scheduled/);
}

const legacyMetadata: ReportListItem = {
  ...scheduledMetadata,
  id: 'report-legacy',
  period: { end: '2026-06-14', start: '2026-06-08' },
  storageUri: 'sample-a/reports/private/report-legacy.json',
};
const olderMetadata: ReportListItem = {
  ...scheduledMetadata,
  id: 'report-older',
  period: { end: '2026-06-07', start: '2026-06-01' },
  storageUri: 'sample-a/reports/private/report-older.json',
};
const legacyReport: PrivateReportJsonV1 = {
  ...scheduledReport,
  project_overview: undefined,
  report_id: 'report-legacy',
};
const olderReport: PrivateReportJsonV1 = {
  ...scheduledReport,
  report_id: 'report-older',
};
await storage.put(legacyMetadata.storageUri, `${JSON.stringify(legacyReport, null, 2)}\n`);
await storage.put(olderMetadata.storageUri, `${JSON.stringify(olderReport, null, 2)}\n`);

const latestLegacyRepository: ReportRepository = {
  ...repository,
  async readLatestScheduledReport() {
    return legacyMetadata;
  },
};
const latestLegacyView = await loadLatestProjectOverview({
  isMember: true,
  projectId: 'project-a',
  projectSlug: 'sample-a',
  repository: latestLegacyRepository,
  storage,
});
assert.equal(latestLegacyView.kind, 'empty');

const nextLatestRepository: ReportRepository = {
  ...repository,
  async readLatestScheduledReport() {
    return olderMetadata;
  },
};
const nextLatestView = await loadLatestProjectOverview({
  isMember: true,
  projectId: 'project-a',
  projectSlug: 'sample-a',
  repository: nextLatestRepository,
  storage,
});
assert.equal(nextLatestView.kind, 'ready');
if (nextLatestView.kind === 'ready') {
  assert.equal(nextLatestView.snapshot.pufuInput.report_id, overviewPufuKey);
  assert.equal(nextLatestView.snapshot.reportHref, '/projects/sample-a/reports/report-older');
}

const sensitiveReport: PrivateReportJsonV1 = {
  ...scheduledReport,
  pufu_sources: [
    {
      canonical_uri: 'https://internal.corp.example/doc',
      doc_type: 'issue',
      document_id: 'doc-sensitive',
      occurred_at: '2026-06-03T00:00:00.000Z token=hidden-value',
      snippet: 'token=hidden-value contact@example.com',
      title: 'Issue secret=abc',
    },
  ],
  sections: [
    {
      id: 'activity',
      items: [{ document_id: 'doc-hidden' }],
      markdown: 'https://internal.corp.example/path',
      metrics: { count: 1 },
      sources: [
        {
          canonical_uri: 'https://internal.corp.example/source',
          doc_type: 'issue',
          document_id: 'doc-source',
          snippet: 'api_key=hidden',
          title: 'hidden',
        },
      ],
      title: '概況',
    },
  ],
};
await storage.put(scheduledMetadata.storageUri, `${JSON.stringify(sensitiveReport, null, 2)}\n`);
const sensitiveView = await loadLatestProjectOverview({
  isMember: true,
  projectId: 'project-a',
  projectSlug: 'sample-a',
  repository,
  storage,
});
assert.equal(sensitiveView.kind, 'ready');
if (sensitiveView.kind === 'ready') {
  const serialized = JSON.stringify(sensitiveView.snapshot.pufuInput);
  assert.doesNotMatch(
    serialized,
    /document_id|canonical_uri|api_key|hidden-value|contact@example.com/,
  );
  assert.doesNotMatch(serialized, /internal\.corp\.example|"items"|"metrics"|"sources"/);
}
