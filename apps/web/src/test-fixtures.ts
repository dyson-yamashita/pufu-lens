import type { PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';

export const sampleChatSource = {
  canonicalUri: 'https://example.com/spec',
  documentId: 'doc-a',
  docType: 'web_page',
  rawDocumentId: 'raw-a',
  title: 'Spec Update',
};

export const publicReportFixture: PublicReportJsonV1 = {
  period: { end: '2026-06-07', start: '2026-06-01' },
  published_at: '2026-06-04T10:00:00.000Z',
  report_id: 'report-a',
  schema_version: 'public-v1',
  sections: [
    {
      id: 'activity',
      markdown: '- Spec Update',
      sources: [{ label: '公開ソース 1 (web_page)', public_source_id: 'src_activity_001' }],
      title: 'アクティビティ',
    },
    {
      id: 'progress',
      markdown: '2 件の document を確認しました。',
      metrics: { documents: 2 },
      title: '進捗',
    },
  ],
  summary: '公開可能な概要です。',
  title: '週次レポート',
};

export const publicContextBundleFixture: PublicContextBundleV1 = {
  report_id: 'report-a',
  schema_version: 'public-context-v1',
  sections: [
    {
      id: 'activity',
      markdown: '- Spec Update',
      public_source_ids: ['src_activity_001'],
      title: 'アクティビティ',
    },
    {
      id: 'progress',
      markdown: '2 件の document を確認しました。',
      public_source_ids: [],
      title: '進捗',
    },
  ],
};
