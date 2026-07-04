export const REPORT_SUMMARY_PREVIEW_LENGTH = 100;

export function formatReportSummaryPreview(
  summary: string,
  limit = REPORT_SUMMARY_PREVIEW_LENGTH,
): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let preview = '';
  let count = 0;
  for (const { segment } of segmenter.segment(summary)) {
    if (count >= limit) {
      return `${preview}...`;
    }
    preview += segment;
    count += 1;
  }
  return summary;
}
