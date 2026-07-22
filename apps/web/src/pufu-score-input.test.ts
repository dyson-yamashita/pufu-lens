import assert from 'node:assert/strict';
import { buildProjectOverviewPufuReportKey } from './project-overview-data.ts';
import { assertPufuScoreReportInputSafe, toPufuScoreReportInput } from './pufu-score-input.ts';
import { PROJECT_OVERVIEW_SCHEMA_VERSION } from './report-project-overview.ts';
import type { PrivateReportJsonV1 } from './report-schema.ts';

const sensitiveReport: PrivateReportJsonV1 = {
  generated_at: '2026-06-04T00:00:00.000Z',
  period: { end: '2026-06-07', start: '2026-06-01' },
  project_id: 'project-a',
  project_overview: {
    assets: [{ description: 'asset', title: 'asset' }],
    issues: [
      {
        description: 'issue',
        next_action: 'next',
        title: 'issue',
      },
    ],
    schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
    status_summary: 'summary',
  },
  pufu_sources: [
    {
      canonical_uri: 'https://internal.corp.example/doc/1',
      doc_type: 'issue',
      document_id: 'doc-secret-1',
      occurred_at: '2026-06-03T00:00:00.000Z token=hidden-at',
      snippet: 'token=super-secret contact@example.com gs://bucket/private.json',
      title: 'Issue #42 secret=abc123',
    },
  ],
  report_id: '00000000-0000-4000-8000-000000000101',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      items: [{ document_id: 'doc-hidden', title: 'hidden item' }],
      markdown: 'See https://internal.corp.example/path and storage_uri=gs://bucket/x',
      metrics: { hidden: 1 },
      sources: [
        {
          canonical_uri: 'https://internal.corp.example/source',
          doc_type: 'issue',
          document_id: 'doc-source-1',
          snippet: 'api_key=not-for-client',
          title: 'hidden source',
        },
      ],
      title: '概況 token=section-secret',
    },
    {
      id: 'progress',
      markdown: '- progress with document_id=embedded',
      title: '進行状況',
    },
  ],
  summary: 'summary with secret=report-secret',
  title: 'Report title api_key=title-secret',
};

const pufuInput = toPufuScoreReportInput(sensitiveReport);
const serialized = JSON.stringify(pufuInput);

assert.doesNotMatch(serialized, /document_id|canonical_uri|storage_uri|api_key|super-secret/);
assert.doesNotMatch(serialized, /contact@example.com|internal\.corp\.example|gs:\/\/bucket/);
assert.doesNotMatch(serialized, /"items"|"metrics"|"sources"|"project_id"/);
assert.doesNotMatch(serialized, /doc-secret-1|doc-hidden|doc-source-1/);
assert.doesNotMatch(serialized, /hidden-at/);
assert.equal(pufuInput.report_id, '00000000-0000-4000-8000-000000000101');
assert.equal(pufuInput.sections.length, 2);
assert.deepEqual(Object.keys(pufuInput.sections[0] ?? {}).sort(), ['id', 'markdown', 'title']);
assertPufuScoreReportInputSafe(pufuInput);

const overviewKey = buildProjectOverviewPufuReportKey({
  period: sensitiveReport.period,
  projectSlug: 'sample-a',
});
const overviewInput = toPufuScoreReportInput(sensitiveReport, { reportKey: overviewKey });
assert.equal(overviewInput.report_id, 'project-overview-sample-a-2026-06-01-2026-06-07');
assert.doesNotMatch(JSON.stringify(overviewInput), /00000000-0000-4000-8000-000000000101/);

const longUriInput = toPufuScoreReportInput({
  ...sensitiveReport,
  summary: `https://example.com/${'a'.repeat(20_000)}`,
});
assert.equal(longUriInput.summary, '[redacted]');
