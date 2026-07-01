import assert from 'node:assert/strict';
import { renderReportPdf, safeReportPdfLines } from './report-pdf.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const standardReport: PrivateReportJsonV1 = {
  generated_at: '2026-06-30T00:00:00.000Z',
  period: { end: '2026-06-30', start: '2026-06-24' },
  project_id: 'project-a',
  report_id: 'report-a',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown:
        'Completed **work** with secret token abc and alice@example.com. storage_uri should not leak.',
      title: 'Activity',
    },
  ],
  summary: 'Weekly summary with raw_document_id mention.',
  title: 'Weekly Report',
};

const lines = safeReportPdfLines(standardReport);
const redactedText = lines.join('\n');
assert.equal(lines.includes('Weekly Report'), true);
assert.equal(redactedText.includes('[redacted]'), true);
assert.equal(redactedText.includes('alice@example.com'), false);
assert.equal(redactedText.includes('raw_document_id'), false);
assert.equal(redactedText.includes('storage_uri'), false);
assert.equal(redactedText.toLowerCase().includes('raw document id'), false);
assert.equal(redactedText.toLowerCase().includes('storage uri'), false);

const pdf = await renderReportPdf({ projectSlug: 'sample/project', report: standardReport });
assert.equal(pdf.fileName, 'sample-project-report-a.pdf');
assert.equal(new TextDecoder().decode(pdf.bytes).startsWith('%PDF-'), true);

const japaneseReport: PrivateReportJsonV1 = {
  ...standardReport,
  sections: [
    {
      id: 'activity',
      markdown: '判定結果\n\nプ譜の進捗は順調です。',
      title: '活動',
    },
  ],
  summary: '週次サマリー',
  title: '週次レポート',
};
const japaneseLines = safeReportPdfLines(japaneseReport);
assert.equal(
  japaneseLines.some((line) => line.includes('週次レポート')),
  true,
);
assert.equal(
  japaneseLines.some((line) => line.includes('判定結果')),
  true,
);
assert.equal(
  japaneseLines.some((line) => line.includes('プ譜')),
  true,
);
const japanesePdf = await renderReportPdf({
  projectSlug: 'sample-project',
  report: japaneseReport,
});
assert.equal(new TextDecoder().decode(japanesePdf.bytes).startsWith('%PDF-'), true);

const customReport: PrivateReportJsonV1 = {
  ...standardReport,
  custom_layout: {
    layout: {
      root: {
        children: [
          { id: 'title', text: 'Custom Title', type: 'title' },
          {
            alt_text: 'private_raw_locator://reports/report-a',
            asset_ref: 'asset-logo',
            caption: 'storage_uri gs://private-bucket/logo.png token abc user@example.com',
            id: 'logo',
            type: 'fixed_image',
          },
          {
            id: 'score',
            left_label: 'Low',
            prompt: 'Judge',
            result_key: 'score_result',
            right_label: 'High',
            type: 'slider_judgement',
          },
          { id: 'copyright', text: '© Pufu Lens', type: 'copyright' },
        ],
        id: 'root',
        type: 'row',
      },
      schema_version: 'custom-report-layout-v1',
    },
    results: {
      score_result: {
        left_label: 'Low',
        part_id: 'score',
        reason: 'Progress is steady.',
        right_label: 'High',
        score: 82,
        type: 'slider_judgement',
      },
    },
    schema_version: 'custom-report-snapshot-v1',
    template_id: 'template-a',
    template_snapshot_hash: 'hash-a',
    template_version: 1,
  },
};
assert.equal(safeReportPdfLines(customReport).join('\n').includes('Custom Title'), true);
assert.equal(safeReportPdfLines(customReport).join('\n').includes('82'), true);
const customPdfText = safeReportPdfLines(customReport).join('\n');
assert.equal(customPdfText.includes('private_raw_locator'), false);
assert.equal(customPdfText.includes('storage_uri'), false);
assert.equal(customPdfText.includes('user@example.com'), false);
assert.equal(customPdfText.includes('[redacted]'), true);

const nullMetricsReport: PrivateReportJsonV1 = {
  ...standardReport,
  sections: [
    {
      id: 'activity',
      markdown: 'Activity note',
      metrics: null as unknown as Record<string, number>,
      title: 'Activity',
    },
  ],
};
assert.doesNotThrow(() => safeReportPdfLines(nullMetricsReport));

console.log('web report pdf tests passed');
