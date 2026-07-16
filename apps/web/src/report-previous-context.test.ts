import assert from 'node:assert/strict';
import {
  buildPreviousReportProviderContext,
  countProviderTokensConservative,
  extractContinuedRisks,
  PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS,
  PREVIOUS_REPORT_CONTEXT_MAX_TOKENS,
  PREVIOUS_REPORT_CONTEXT_TRIM_MAX_TOKEN_COUNT_CALLS,
  serializePreviousReportContext,
} from './report-previous-context.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const baseReport = (overrides: Partial<PrivateReportJsonV1> = {}): PrivateReportJsonV1 => ({
  generated_at: '2026-05-25T00:00:00.000Z',
  period: { end: '2026-05-31', start: '2026-05-25' },
  project_id: 'project-a',
  pufu_sources: [
    {
      canonical_uri: 'https://internal.corp/issues/1',
      doc_type: 'issue',
      document_id: 'doc-b',
      occurred_at: '2026-05-26T00:00:00.000Z',
      snippet: 'gs://private-bucket/report.json',
      title: 'Issue B',
    },
    {
      canonical_uri: 'https://example.com/issues/2',
      doc_type: 'pull_request',
      document_id: 'doc-a',
      occurred_at: '2026-05-27T00:00:00.000Z',
      snippet: 'Merged UI contact@example.com',
      title: 'PR A',
    },
  ],
  report_id: 'previous-report-a',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown: 'Activity body',
      title: '概況',
    },
    {
      id: 'risks',
      items: [{ title: 'Login failure risk' }],
      markdown: '- Blocked release\n- Needs follow-up',
      title: '課題・次のアクション',
    },
  ],
  summary: 'Previous summary',
  title: 'Previous title',
  ...overrides,
});

assert.deepEqual(extractContinuedRisks(baseReport()), [
  'Login failure risk',
  'Blocked release',
  'Needs follow-up',
]);

const built = await buildPreviousReportProviderContext({
  frequency: 'weekly',
  previousReport: baseReport(),
  previousReportId: 'previous-report-a',
});

assert.equal(built.previousReportId, 'previous-report-a');
assert.equal(built.frequency, 'weekly');
assert.equal(built.payload.sources[0]?.title, 'PR A');
assert.equal(built.payload.sources[1]?.title, 'Issue B');
assert.equal(built.payload.sources[0]?.docType, 'pull_request');
assert.ok(!built.serialized.includes('document_id'));
assert.ok(!built.serialized.includes('canonical_uri'));
assert.ok(!built.serialized.includes('contact@example.com'));
assert.ok(built.serialized.includes('[redacted-email]'));
assert.ok(!built.serialized.includes('private-bucket'));
assert.ok(built.serialized.includes('[redacted-uri]'));
assert.ok(built.payload.sources[1]?.occurredAt?.includes('2026-05-26'));
assert.equal(countProviderTokensConservative('あいう'), 9);
assert.equal(countProviderTokensConservative('abc'), 3);
assert.equal(countCodePoints(built.serialized) <= PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS, true);
assert.equal(
  countProviderTokensConservative(built.serialized) <= PREVIOUS_REPORT_CONTEXT_MAX_TOKENS,
  true,
);

const deterministic = await buildPreviousReportProviderContext({
  frequency: 'weekly',
  previousReport: baseReport(),
  previousReportId: 'previous-report-a',
});
assert.equal(deterministic.serialized, built.serialized);

const oversizedReport = baseReport({
  pufu_sources: Array.from({ length: 30 }, (_, index) => ({
    canonical_uri: `https://example.com/${index}`,
    doc_type: 'issue',
    document_id: `doc-${String(index).padStart(3, '0')}`,
    occurred_at: `2026-05-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    snippet: 'x'.repeat(500),
    title: `Title ${index}`,
  })),
  summary: 's'.repeat(5_000),
});
const trimmed = await buildPreviousReportProviderContext({
  countTokens: async (text) => countProviderTokensConservative(text),
  frequency: 'weekly',
  previousReport: oversizedReport,
  previousReportId: 'previous-report-a',
});
assert.ok(trimmed.payload.sources.length <= 20);
assert.ok(countCodePoints(trimmed.serialized) <= PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS);
assert.ok(
  countProviderTokensConservative(trimmed.serialized) <= PREVIOUS_REPORT_CONTEXT_MAX_TOKENS,
);

let tokenCounterCalls = 0;
await buildPreviousReportProviderContext({
  countTokens: async (text) => {
    tokenCounterCalls += 1;
    return countProviderTokensConservative(text);
  },
  frequency: 'weekly',
  previousReport: oversizedReport,
  previousReportId: 'previous-report-a',
});
assert.ok(tokenCounterCalls <= PREVIOUS_REPORT_CONTEXT_TRIM_MAX_TOKEN_COUNT_CALLS);
assert.ok(tokenCounterCalls > 0);
assert.ok(tokenCounterCalls < 100);

await assert.rejects(
  () =>
    buildPreviousReportProviderContext({
      countTokens: async () => PREVIOUS_REPORT_CONTEXT_MAX_TOKENS + 1,
      frequency: 'weekly',
      previousReport: baseReport(),
      previousReportId: 'previous-report-a',
    }),
  /token budget after trimming/,
);

const originalReport = baseReport();
await buildPreviousReportProviderContext({
  frequency: 'weekly',
  previousReport: originalReport,
  previousReportId: 'previous-report-a',
});
assert.deepEqual(originalReport.pufu_sources?.[0], baseReport().pufu_sources?.[0]);

assert.equal(
  serializePreviousReportContext({
    continuedRisks: ['risk'],
    frequency: 'weekly',
    previousReportId: 'previous-report-a',
    sections: [{ summary: 'section', title: 'Section' }],
    sources: [
      {
        docType: 'issue',
        occurredAt: null,
        snippet: 'snippet',
        title: 'Source',
      },
    ],
    summary: 'summary',
  }),
  JSON.stringify({
    continued_risks: ['risk'],
    frequency: 'weekly',
    previous_report_id: 'previous-report-a',
    sections: [{ summary: 'section', title: 'Section' }],
    sources: [
      {
        doc_type: 'issue',
        occurred_at: null,
        snippet: 'snippet',
        title: 'Source',
      },
    ],
    summary: 'summary',
  }),
);

function countCodePoints(value: string): number {
  return [...value].length;
}

console.log('report-previous-context.test.ts: ok');
