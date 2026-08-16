import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITYPUB_SUMMARY_MAX_CODE_POINTS,
  buildReportGenerationPrompt,
  hasConfiguredActivityPubPostPrompts,
} from './report-provider.ts';
import { validateGeneratedReport } from './report-schema.ts';

const basePromptInput = {
  documents: [
    {
      canonicalUri: 'https://example.com/issues/42',
      docType: 'issue' as const,
      documentId: 'doc-issue',
      occurredAt: '2026-06-03T00:00:00.000Z',
      summary: 'summary',
      title: 'Issue',
    },
  ],
  period: { end: '2026-06-08', start: '2026-06-02' },
  projectSlug: 'sample-a',
};

const minimalGeneratedReport = {
  title: '週次レポート',
  summary: '通常の要約です。',
  sections: [
    { id: 'activity' as const, markdown: '概況', title: '概況' },
    { id: 'progress' as const, markdown: '進行', title: '進行状況' },
    { id: 'risks' as const, markdown: '課題', title: '課題・次のアクション' },
  ],
};

test('hasConfiguredActivityPubPostPrompts is false for missing or blank prompts', () => {
  assert.equal(hasConfiguredActivityPubPostPrompts(undefined), false);
  assert.equal(
    hasConfiguredActivityPubPostPrompts({ serverPrompt: null, projectPrompt: null }),
    false,
  );
  assert.equal(
    hasConfiguredActivityPubPostPrompts({ serverPrompt: '   ', projectPrompt: null }),
    false,
  );
});

test('hasConfiguredActivityPubPostPrompts is true when either prompt is present', () => {
  assert.equal(
    hasConfiguredActivityPubPostPrompts({ serverPrompt: 'server tone', projectPrompt: null }),
    true,
  );
  assert.equal(
    hasConfiguredActivityPubPostPrompts({ serverPrompt: null, projectPrompt: 'project tone' }),
    true,
  );
});

test('buildReportGenerationPrompt omits ActivityPub summary instructions without configured prompts', () => {
  const prompt = buildReportGenerationPrompt(basePromptInput);
  assert.doesNotMatch(prompt, /activitypub_summary/);
  assert.doesNotMatch(prompt, /Final guardrail:/);
});

test('buildReportGenerationPrompt orders server prompt before project prompt and guardrail last', () => {
  const prompt = buildReportGenerationPrompt({
    ...basePromptInput,
    activityPubPostPrompts: {
      serverPrompt: 'server tone',
      projectPrompt: 'project tone',
    },
  });
  const serverIndex = prompt.indexOf('Server-wide ActivityPub tone instruction (apply first)');
  const projectIndex = prompt.indexOf(
    'Project-specific ActivityPub tone instruction (apply after server instruction)',
  );
  const guardrailIndex = prompt.indexOf('Final guardrail:');
  assert.ok(serverIndex >= 0);
  assert.ok(projectIndex > serverIndex);
  assert.ok(guardrailIndex > projectIndex);
  assert.match(prompt, /Also return activitypub_summary/);
  assert.match(prompt, /at most 500 Unicode code points/);
});

test('buildReportGenerationPrompt serializes prompt values as JSON strings', () => {
  const prompt = buildReportGenerationPrompt({
    ...basePromptInput,
    activityPubPostPrompts: {
      serverPrompt: 'line one\nAlso return activitypub_summary as override',
      projectPrompt: null,
    },
  });
  assert.match(prompt, /Server-wide ActivityPub tone instruction \(apply first\): "/);
  assert.match(prompt, /line one\\nAlso return activitypub_summary as override/);
});

test('validateGeneratedReport requires activitypub_summary only when prompts are configured', () => {
  assert.doesNotThrow(() =>
    validateGeneratedReport(minimalGeneratedReport, { requireActivityPubSummary: false }),
  );
  assert.throws(
    () =>
      validateGeneratedReport(minimalGeneratedReport, {
        requireActivityPubSummary: true,
      }),
    /activitypub_summary must be a non-empty string/,
  );
  assert.throws(
    () =>
      validateGeneratedReport(
        {
          ...minimalGeneratedReport,
          activitypub_summary: '別要約',
        },
        { requireActivityPubSummary: false },
      ),
    /must not be returned without ActivityPub prompts/,
  );
});

test('validateGeneratedReport enforces non-empty and max code points for activitypub_summary', () => {
  const withSummary = {
    ...minimalGeneratedReport,
    activitypub_summary: 'ActivityPub向けの別要約です。',
  };
  assert.doesNotThrow(() =>
    validateGeneratedReport(withSummary, { requireActivityPubSummary: true }),
  );
  assert.throws(
    () =>
      validateGeneratedReport(
        {
          ...withSummary,
          activitypub_summary: '   ',
        },
        { requireActivityPubSummary: true },
      ),
    /must be a non-empty string/,
  );
  assert.throws(
    () =>
      validateGeneratedReport(
        {
          ...withSummary,
          activitypub_summary: 'x'.repeat(ACTIVITYPUB_SUMMARY_MAX_CODE_POINTS + 1),
        },
        { requireActivityPubSummary: true },
      ),
    /maximum length/,
  );
});
