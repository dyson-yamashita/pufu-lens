import assert from 'node:assert/strict';
import test from 'node:test';
import { publishGeneratedPublicReport } from './report-publication.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const report: PrivateReportJsonV1 = {
  generated_at: '2026-06-08T12:00:00.000Z',
  period: { end: '2026-06-08', start: '2026-06-02' },
  project_id: '00000000-0000-0000-0000-000000000001',
  report_id: '00000000-0000-0000-0000-000000000002',
  schema_version: 'v1',
  sections: [
    { id: 'activity', markdown: '概況', title: '概況' },
    { id: 'progress', markdown: '進行', title: '進行状況' },
    { id: 'risks', markdown: '課題', title: '課題・次のアクション' },
  ],
  summary: '公開レポート用の通常要約',
  title: '週次レポート',
};

test('publishGeneratedPublicReport keeps ordinary summary in artifacts and passes ActivityPub summary separately', async () => {
  let persistedSummary: string | undefined;
  const storage = {
    put: async (path: string, _body: string) => ({
      uri: `gs://bucket/${path}`,
      etag: 'etag',
    }),
  };

  const result = await publishGeneratedPublicReport({
    project: {
      id: report.project_id,
      slug: 'sample-a',
      graphName: null,
      visibility: 'public',
    },
    publishedAt: '2026-06-08T12:00:00.000Z',
    report,
    activityPubSummary: 'ActivityPub配信用の別要約',
    repository: {
      setReportPublicState: async (input: { readonly publicSummary?: string }) => {
        persistedSummary = input.publicSummary;
      },
    } as never,
    storage: storage as never,
  });

  assert.equal(result.publicReport.summary, '公開レポート用の通常要約');
  assert.equal(persistedSummary, 'ActivityPub配信用の別要約');
});

test('publishGeneratedPublicReport falls back to ordinary summary when ActivityPub summary is absent', async () => {
  let persistedSummary: string | undefined;
  const storage = {
    put: async (path: string) => ({
      uri: `gs://bucket/${path}`,
      etag: 'etag',
    }),
  };

  await publishGeneratedPublicReport({
    project: {
      id: report.project_id,
      slug: 'sample-a',
      graphName: null,
      visibility: 'public',
    },
    publishedAt: '2026-06-08T12:00:00.000Z',
    report,
    repository: {
      setReportPublicState: async (input: { readonly publicSummary?: string }) => {
        persistedSummary = input.publicSummary;
      },
    } as never,
    storage: storage as never,
  });

  assert.equal(persistedSummary, '公開レポート用の通常要約');
});
