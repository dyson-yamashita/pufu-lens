import assert from 'node:assert/strict';
import { formatReportSummaryPreview, REPORT_SUMMARY_PREVIEW_LENGTH } from './report-summary.ts';

assert.equal(
  formatReportSummaryPreview('a'.repeat(REPORT_SUMMARY_PREVIEW_LENGTH)),
  'a'.repeat(REPORT_SUMMARY_PREVIEW_LENGTH),
);
assert.equal(
  formatReportSummaryPreview('あ'.repeat(REPORT_SUMMARY_PREVIEW_LENGTH + 1)),
  `${'あ'.repeat(REPORT_SUMMARY_PREVIEW_LENGTH)}...`,
);
assert.equal(
  formatReportSummaryPreview('👨‍👩‍👧‍👦'.repeat(REPORT_SUMMARY_PREVIEW_LENGTH + 1)),
  `${'👨‍👩‍👧‍👦'.repeat(REPORT_SUMMARY_PREVIEW_LENGTH)}...`,
);
assert.equal(formatReportSummaryPreview('short summary'), 'short summary');

console.log('web report summary tests passed');
