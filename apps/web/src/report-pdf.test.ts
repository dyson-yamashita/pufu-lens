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
assert.equal(lines.includes('Weekly Report'), true);
assert.equal(lines.join('\n').includes('alice@example.com'), false);
assert.equal(lines.join('\n').includes('raw_document_id'), false);
assert.equal(lines.join('\n').includes('storage_uri'), false);

const pdf = renderReportPdf({ projectSlug: 'sample/project', report: standardReport });
assert.equal(pdf.fileName, 'sample-project-report-a.pdf');
assert.equal(new TextDecoder().decode(pdf.bytes).startsWith('%PDF-1.4'), true);
assert.equal(new TextDecoder().decode(pdf.bytes).includes('/Type /Catalog'), true);

const customReport: PrivateReportJsonV1 = {
  ...standardReport,
  custom_layout: {
    layout: {
      root: {
        children: [
          { id: 'title', text: 'Custom Title', type: 'title' },
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

console.log('web report pdf tests passed');
