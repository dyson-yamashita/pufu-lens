import assert from 'node:assert/strict';
import { MemoryObjectStorage } from '@pufu-lens/storage/testing';
import { createMastraGenerateReportWorkflowBody } from './mastra-workflow.ts';
import type { PrivateReportJsonV1, ReportRepository } from './report.ts';
import { runGenerateReport } from './report-generation.ts';
import {
  buildPreviousReportProviderContext,
  countProviderTokensConservative,
  PREVIOUS_REPORT_CONTEXT_TRIM_MAX_TOKEN_COUNT_CALLS,
  type PreviousReportProviderContext,
} from './report-previous-context.ts';
import {
  loadTrustedPreviousScheduledReport,
  PreviousScheduledReportNotFoundError,
} from './report-previous-report.ts';
import type { ReportGenerationProvider } from './report-provider.ts';
import {
  buildReportGenerationPrompt,
  countGeminiProviderTokens,
  createExtractiveReportProvider,
  createGeminiReportProvider,
  createGeminiReportProviderWithExtractiveFallback,
  GEMINI_COUNT_TOKENS_TIMEOUT_MS,
  resolveGeminiCountTokensEndpoint,
  resolveProviderCountTokens,
} from './report-provider.ts';
import { buildTrustedReportRecurrence } from './report-recurrence.ts';
import {
  PartialScheduleInputError,
  validatePairedScheduleInputs,
} from './report-schedule-input.ts';
import { validateGeneratedReport } from './report-schema.ts';

assert.equal(validatePairedScheduleInputs({}), undefined);
assert.deepEqual(
  validatePairedScheduleInputs({
    previousScheduledReportId: 'report-prev',
    scheduleFrequency: 'weekly',
  }),
  { previousScheduledReportId: 'report-prev', scheduleFrequency: 'weekly' },
);
assert.throws(
  () => validatePairedScheduleInputs({ previousScheduledReportId: 'report-prev' }),
  PartialScheduleInputError,
);
assert.throws(
  () => validatePairedScheduleInputs({ scheduleFrequency: 'weekly' }),
  PartialScheduleInputError,
);

assert.deepEqual(
  createMastraGenerateReportWorkflowBody({
    previousScheduledReportId: 'report-prev',
    projectSlug: 'sample-a',
    scheduleFrequency: 'weekly',
  }),
  {
    inputData: {
      previousScheduledReportId: 'report-prev',
      projectSlug: 'sample-a',
      scheduleFrequency: 'weekly',
    },
  },
);
assert.throws(
  () =>
    createMastraGenerateReportWorkflowBody({
      previousScheduledReportId: 'report-prev',
      projectSlug: 'sample-a',
    }),
  PartialScheduleInputError,
);

const previousReportJson: PrivateReportJsonV1 = {
  generated_at: '2026-05-25T00:00:00.000Z',
  period: { end: '2026-05-31', start: '2026-05-25' },
  project_id: 'project-a',
  pufu_sources: [
    {
      canonical_uri: 'https://example.com/issues/1',
      doc_type: 'issue',
      document_id: 'doc-prev',
      occurred_at: '2026-05-26T00:00:00.000Z',
      snippet: 'Previous risk',
      title: 'Issue previous',
    },
  ],
  report_id: 'report-prev',
  schema_version: 'v1',
  sections: [
    { id: 'activity', markdown: 'Previous activity', title: '概況' },
    {
      id: 'risks',
      markdown: '- Login failure risk',
      title: '課題・次のアクション',
    },
  ],
  summary: 'Previous weekly summary',
  title: 'Previous weekly report',
};

const storage = new MemoryObjectStorage();
await storage.put(
  'sample-a/reports/private/report-prev.json',
  `${JSON.stringify(previousReportJson, null, 2)}\n`,
);

function createRecurrenceRepository(): ReportRepository {
  return {
    async deleteReport() {},
    async insertReport({ report, storageUri }) {
      await storage.put(storageUri, `${JSON.stringify(report, null, 2)}\n`);
      return undefined;
    },
    async listRecentDocuments() {
      return [
        {
          canonicalUri: 'https://example.com/issues/42',
          docType: 'issue',
          documentId: 'doc-issue',
          occurredAt: '2026-06-03T00:00:00.000Z',
          summary: 'Login failure risk',
          title: 'Issue #42 Login failure',
        },
      ];
    },
    async listReports() {
      return [];
    },
    async readLatestScheduledReport() {
      return undefined;
    },
    async lookupProject({ projectSlug }) {
      return projectSlug === 'sample-a'
        ? { graphName: null, id: 'project-a', slug: 'sample-a', visibility: 'private' }
        : undefined;
    },
    async lookupProjectMember() {
      return undefined;
    },
    async readReportMetadata({ projectId, reportId }) {
      if (projectId === 'project-a' && reportId === 'report-prev') {
        return {
          createdAt: '2026-05-31T00:00:00.000Z',
          generationKind: 'scheduled',
          id: 'report-prev',
          isPublic: false,
          period: { end: '2026-05-31', start: '2026-05-25' },
          previousScheduledReportId: null,
          scheduleFrequency: 'weekly',
          schedulePeriodRunId: 'run-prev',
          schemaVersion: 'v1',
          storageUri: 'sample-a/reports/private/report-prev.json',
          summary: 'Previous weekly summary',
          title: 'Previous weekly report',
        };
      }
      if (projectId === 'project-a' && reportId === 'manual-report') {
        return {
          createdAt: '2026-05-31T00:00:00.000Z',
          generationKind: 'manual',
          id: 'manual-report',
          isPublic: false,
          period: { end: '2026-05-31', start: '2026-05-25' },
          previousScheduledReportId: null,
          scheduleFrequency: null,
          schedulePeriodRunId: null,
          schemaVersion: 'v1',
          storageUri: 'sample-a/reports/private/manual-report.json',
          summary: 'manual',
          title: 'manual',
        };
      }
      if (projectId === 'project-b' && reportId === 'cross-project-report') {
        return {
          createdAt: '2026-05-31T00:00:00.000Z',
          generationKind: 'scheduled',
          id: 'cross-project-report',
          isPublic: false,
          period: { end: '2026-05-31', start: '2026-05-25' },
          previousScheduledReportId: null,
          scheduleFrequency: 'weekly',
          schedulePeriodRunId: 'run-cross',
          schemaVersion: 'v1',
          storageUri: 'project-b/reports/private/cross-project-report.json',
          summary: 'cross',
          title: 'cross',
        };
      }
      return undefined;
    },
    async setReportPublicState() {},
  };
}

const repository = createRecurrenceRepository();
const newPeriod = { end: '2026-06-07', start: '2026-06-01' };

const loaded = await loadTrustedPreviousScheduledReport({
  newPeriod,
  previousScheduledReportId: 'report-prev',
  projectId: 'project-a',
  repository,
  scheduleFrequency: 'weekly',
  storage,
});
assert.equal(loaded.report_id, 'report-prev');

await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod,
      previousScheduledReportId: 'missing',
      projectId: 'project-a',
      repository,
      scheduleFrequency: 'weekly',
      storage,
    }),
  PreviousScheduledReportNotFoundError,
);

await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod,
      previousScheduledReportId: 'cross-project-report',
      projectId: 'project-a',
      repository,
      scheduleFrequency: 'weekly',
      storage,
    }),
  PreviousScheduledReportNotFoundError,
);

await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod,
      previousScheduledReportId: 'manual-report',
      projectId: 'project-a',
      repository,
      scheduleFrequency: 'weekly',
      storage,
    }),
  PreviousScheduledReportNotFoundError,
);

await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod,
      previousScheduledReportId: 'report-prev',
      projectId: 'project-a',
      repository,
      scheduleFrequency: 'monthly',
      storage,
    }),
  PreviousScheduledReportNotFoundError,
);

const tamperedProjectStorageUri = 'sample-a/reports/private/tampered-project-report.json';
await storage.put(
  tamperedProjectStorageUri,
  `${JSON.stringify({ ...previousReportJson, project_id: 'project-b' }, null, 2)}\n`,
);
const tamperedProjectRepository: ReportRepository = {
  ...repository,
  async readReportMetadata({ projectId, reportId }) {
    if (projectId === 'project-a' && reportId === 'tampered-project-report') {
      return {
        createdAt: '2026-05-31T00:00:00.000Z',
        generationKind: 'scheduled',
        id: 'tampered-project-report',
        isPublic: false,
        period: { end: '2026-05-31', start: '2026-05-25' },
        previousScheduledReportId: null,
        scheduleFrequency: 'weekly',
        schedulePeriodRunId: 'run-tampered',
        schemaVersion: 'v1',
        storageUri: tamperedProjectStorageUri,
        summary: 'tampered',
        title: 'tampered',
      };
    }
    return repository.readReportMetadata({ projectId, reportId });
  },
};
await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod,
      previousScheduledReportId: 'tampered-project-report',
      projectId: 'project-a',
      repository: tamperedProjectRepository,
      scheduleFrequency: 'weekly',
      storage,
    }),
  PreviousScheduledReportNotFoundError,
);

await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod: { end: '2026-05-31', start: '2026-05-25' },
      previousScheduledReportId: 'report-prev',
      projectId: 'project-a',
      repository,
      scheduleFrequency: 'weekly',
      storage,
    }),
  PreviousScheduledReportNotFoundError,
);

const malformedStorageUri = 'sample-a/reports/private/malformed-report.json';
await storage.put(malformedStorageUri, '{ "schema_version": "v2" }\n');
const malformedRepository: ReportRepository = {
  ...repository,
  async readReportMetadata({ projectId, reportId }) {
    if (projectId === 'project-a' && reportId === 'malformed-report') {
      return {
        createdAt: '2026-05-31T00:00:00.000Z',
        generationKind: 'scheduled',
        id: 'malformed-report',
        isPublic: false,
        period: { end: '2026-05-31', start: '2026-05-25' },
        previousScheduledReportId: null,
        scheduleFrequency: 'weekly',
        schedulePeriodRunId: 'run-malformed',
        schemaVersion: 'v1',
        storageUri: malformedStorageUri,
        summary: 'malformed',
        title: 'malformed',
      };
    }
    return repository.readReportMetadata({ projectId, reportId });
  },
};
await assert.rejects(
  () =>
    loadTrustedPreviousScheduledReport({
      newPeriod,
      previousScheduledReportId: 'malformed-report',
      projectId: 'project-a',
      repository: malformedRepository,
      scheduleFrequency: 'weekly',
      storage,
    }),
  /schema_version/,
);

let providerContext: PreviousReportProviderContext | undefined;
const trackingProvider: ReportGenerationProvider = {
  async generate(input) {
    providerContext = input.previousReportContext;
    return {
      change_summary: '前回から活動が継続しました。',
      continued_items: ['Login failure risk'],
      decrements: [],
      increments: ['新しい資料を整理しました。'],
      sections: [
        { id: 'activity' as const, markdown: 'Current activity', title: '概況' },
        { id: 'progress' as const, markdown: '- progress', title: '進行状況' },
        { id: 'risks' as const, markdown: '- risk', title: '課題・次のアクション' },
      ],
      summary: 'Current summary',
      title: 'Current title',
    };
  },
};

const generated = await runGenerateReport({
  options: {
    now: new Date('2026-06-04T12:00:00.000Z'),
    period: newPeriod,
    previousScheduledReportId: 'report-prev',
    provider: trackingProvider,
    repository,
    scheduleFrequency: 'weekly',
    storage,
  },
  projectSlug: 'sample-a',
});
assert.ok(providerContext);
assert.equal(providerContext?.previousReportId, 'report-prev');
assert.equal(generated.report.recurrence?.previous_report_id, 'report-prev');
assert.equal(generated.report.recurrence?.frequency, 'weekly');
assert.equal(generated.report.recurrence?.change_summary, '前回から活動が継続しました。');
assert.deepEqual(generated.report.recurrence?.decrements, []);

const manualGenerated = await runGenerateReport({
  options: {
    now: new Date('2026-06-04T12:00:00.000Z'),
    period: newPeriod,
    provider: createExtractiveReportProvider(),
    repository,
    storage,
  },
  projectSlug: 'sample-a',
});
assert.equal(manualGenerated.report.recurrence, undefined);

await assert.rejects(
  () =>
    runGenerateReport({
      options: {
        now: new Date('2026-06-04T12:00:00.000Z'),
        period: newPeriod,
        previousScheduledReportId: 'report-prev',
        provider: {
          async generate() {
            return {
              sections: [
                { id: 'activity', markdown: 'a', title: '概況' },
                { id: 'progress', markdown: '- p', title: '進行状況' },
                { id: 'risks', markdown: '- r', title: '課題・次のアクション' },
              ],
              summary: 'summary',
              title: 'title',
            };
          },
        },
        repository,
        scheduleFrequency: 'weekly',
        storage,
      },
      projectSlug: 'sample-a',
    }),
  /recurrence delta/,
);

const extractiveWithContext = await runGenerateReport({
  options: {
    now: new Date('2026-06-04T12:00:00.000Z'),
    period: newPeriod,
    previousScheduledReportId: 'report-prev',
    provider: createExtractiveReportProvider(),
    repository,
    scheduleFrequency: 'weekly',
    storage,
  },
  projectSlug: 'sample-a',
});
assert.ok(extractiveWithContext.report.recurrence?.change_summary);
assert.deepEqual(extractiveWithContext.report.recurrence?.decrements, []);

const oversizedRecurrence = buildTrustedReportRecurrence({
  delta: {
    change_summary: `${'変'.repeat(3_000)} contact@example.com gs://secret-bucket/path`,
    continued_items: Array.from({ length: 20 }, (_, index) => `継続${index} ${'x'.repeat(500)}`),
    decrements: [],
    increments: ['増分'],
  },
  frequency: 'weekly',
  previousReportId: 'report-prev',
});
assert.equal(oversizedRecurrence.frequency, 'weekly');
assert.equal(oversizedRecurrence.previous_report_id, 'report-prev');
assert.ok([...oversizedRecurrence.change_summary].length <= 2_000);
assert.ok(oversizedRecurrence.continued_items.length <= 10);
assert.ok(!oversizedRecurrence.change_summary.includes('contact@example.com'));
assert.ok(!oversizedRecurrence.change_summary.includes('secret-bucket'));

assert.throws(
  () =>
    buildTrustedReportRecurrence({
      delta: {
        change_summary: '   ',
        continued_items: [],
        decrements: [],
        increments: [],
      },
      frequency: 'weekly',
      previousReportId: 'report-prev',
    }),
  /empty after sanitization/,
);

const validSections = [
  { id: 'activity' as const, markdown: 'a', title: '概況' },
  { id: 'progress' as const, markdown: '- p', title: '進行状況' },
  { id: 'risks' as const, markdown: '- r', title: '課題・次のアクション' },
];

validateGeneratedReport(
  {
    change_summary: `${'変'.repeat(3_000)} contact@example.com`,
    continued_items: Array.from({ length: 20 }, (_, index) => `継続${index}`),
    decrements: [],
    increments: ['増分'],
    sections: validSections,
    summary: 'summary',
    title: 'title',
  },
  { requireRecurrence: true },
);

const oversizedGenerated = await runGenerateReport({
  options: {
    now: new Date('2026-06-04T12:00:00.000Z'),
    period: newPeriod,
    previousScheduledReportId: 'report-prev',
    provider: {
      async generate() {
        return {
          change_summary: `${'変'.repeat(3_000)} contact@example.com gs://secret-bucket/path`,
          continued_items: Array.from(
            { length: 20 },
            (_, index) => `継続${index} ${'x'.repeat(500)}`,
          ),
          decrements: [],
          increments: ['増分'],
          sections: validSections,
          summary: 'Current summary',
          title: 'Current title',
        };
      },
    },
    repository,
    scheduleFrequency: 'weekly',
    storage,
  },
  projectSlug: 'sample-a',
});
assert.equal(oversizedGenerated.report.recurrence?.previous_report_id, 'report-prev');
assert.equal(oversizedGenerated.report.recurrence?.frequency, 'weekly');
assert.ok([...(oversizedGenerated.report.recurrence?.change_summary ?? '')].length <= 2_000);
assert.ok((oversizedGenerated.report.recurrence?.continued_items.length ?? 0) <= 10);
assert.ok(!oversizedGenerated.report.recurrence?.change_summary.includes('contact@example.com'));
assert.ok(!oversizedGenerated.report.recurrence?.change_summary.includes('secret-bucket'));

await assert.rejects(
  () =>
    runGenerateReport({
      options: {
        now: new Date('2026-06-04T12:00:00.000Z'),
        period: newPeriod,
        previousScheduledReportId: 'report-prev',
        provider: {
          async generate() {
            const output = {
              change_summary: '変化あり',
              continued_items: [],
              decrements: [],
              increments: 'not-an-array' as unknown as string[],
              sections: validSections,
              summary: 'summary',
              title: 'title',
            };
            validateGeneratedReport(output, { requireRecurrence: true });
            return output;
          },
        },
        repository,
        scheduleFrequency: 'weekly',
        storage,
      },
      projectSlug: 'sample-a',
    }),
  /increments must be an array/,
);

const previousContext = await buildPreviousReportProviderContext({
  frequency: 'weekly',
  previousReport: previousReportJson,
  previousReportId: 'report-prev',
});
const prompt = buildReportGenerationPrompt({
  documents: [
    {
      canonicalUri: 'https://example.com/issues/42',
      docType: 'issue',
      documentId: 'doc-issue',
      occurredAt: '2026-06-03T00:00:00.000Z',
      summary: 'summary',
      title: 'Issue',
    },
  ],
  includeProjectOverview: true,
  period: newPeriod,
  previousReportContext: previousContext,
  projectSlug: 'sample-a',
});
assert.match(prompt, /untrusted evidence/);
assert.match(prompt, /change_summary/);
assert.ok(prompt.includes(previousContext.serialized));
assert.match(
  prompt,
  /Write all user-facing generated report text in natural Japanese[\s\S]*project_overview\.status_summary[\s\S]*project_overview\.assets\[\]\.title and description[\s\S]*project_overview\.issues\[\]\.title, description, and next_action[\s\S]*recurrence fields change_summary, increments\[\], decrements\[\], and continued_items\[\][\s\S]*Proper nouns, product names, and code identifiers/,
);

let countTokensCalls = 0;
await countGeminiProviderTokens({
  apiKey: 'test-key',
  fetchImpl: async () => {
    countTokensCalls += 1;
    return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 });
  },
  model: 'gemini-test',
  text: 'hello',
});
assert.equal(countTokensCalls, 1);

assert.equal(
  resolveGeminiCountTokensEndpoint({
    customGenerationEndpoint: 'https://proxy.example/v1beta/models/gemini-test:generateContent',
    model: 'gemini-test',
  }),
  'https://proxy.example/v1beta/models/gemini-test:countTokens',
);
assert.equal(
  resolveGeminiCountTokensEndpoint({
    countTokensEndpoint: 'https://custom-count.example/tokens',
    customGenerationEndpoint: 'https://proxy.example/v1beta/models/gemini-test:generateContent',
    model: 'gemini-test',
  }),
  'https://custom-count.example/tokens',
);
assert.equal(
  resolveGeminiCountTokensEndpoint({
    customGenerationEndpoint: 'https://opaque.example/llm',
    model: 'gemini-test',
  }),
  'https://opaque.example/llm',
);
assert.match(
  resolveGeminiCountTokensEndpoint({ model: 'gemini-test' }),
  /generativelanguage\.googleapis\.com.*countTokens$/,
);

const countTokensRequestUrls: string[] = [];
const customEndpointProvider = createGeminiReportProvider({
  apiKey: 'test-key',
  endpoint: 'https://proxy.example/v1beta/models/gemini-test:generateContent',
  fetchImpl: async (url) => {
    countTokensRequestUrls.push(String(url));
    return new Response(JSON.stringify({ totalTokens: 11 }), { status: 200 });
  },
  model: 'gemini-test',
});
assert.equal(await customEndpointProvider.countTokens?.('hello'), 11);
assert.equal(countTokensRequestUrls.length, 1);
assert.ok(
  countTokensRequestUrls[0]?.includes(
    'https://proxy.example/v1beta/models/gemini-test:countTokens',
  ),
);

let abortObserved = false;
await assert.rejects(
  () =>
    countGeminiProviderTokens({
      apiKey: 'test-key',
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortObserved = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      model: 'gemini-test',
      text: 'hello',
      timeoutMs: 50,
    }),
  /Aborted|abort/i,
);
assert.equal(abortObserved, true);
assert.equal(GEMINI_COUNT_TOKENS_TIMEOUT_MS, 10_000);

let geminiGenerateCalls = 0;
let geminiCountCalls = 0;
const geminiProvider = createGeminiReportProvider({
  apiKey: 'test-key',
  fetchImpl: async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('countTokens')) {
      geminiCountCalls += 1;
      return new Response(JSON.stringify({ totalTokens: 10 }), { status: 200 });
    }
    geminiGenerateCalls += 1;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    change_summary: '変化あり',
                    continued_items: ['継続'],
                    decrements: [],
                    increments: ['増分'],
                    sections: [
                      { id: 'activity', markdown: 'a', title: '概況' },
                      { id: 'progress', markdown: '- p', title: '進行状況' },
                      { id: 'risks', markdown: '- r', title: '課題・次のアクション' },
                    ],
                    summary: 'summary',
                    title: 'title',
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  },
  model: 'gemini-test',
});
await geminiProvider.generate({
  documents: [],
  period: newPeriod,
  previousReportContext: previousContext,
  projectSlug: 'sample-a',
});
assert.equal(geminiCountCalls, 0);
assert.equal(geminiGenerateCalls, 1);
assert.equal(await geminiProvider.countTokens?.('hello'), 10);
assert.equal(geminiCountCalls, 1);

let providerCountCallsDuringGeneration = 0;
const countingGeminiProvider: ReportGenerationProvider = {
  ...geminiProvider,
  countTokens: async (text) => {
    providerCountCallsDuringGeneration += 1;
    return countProviderTokensConservative(text);
  },
};
await runGenerateReport({
  options: {
    now: new Date('2026-06-04T12:00:00.000Z'),
    period: newPeriod,
    previousScheduledReportId: 'report-prev',
    provider: countingGeminiProvider,
    repository,
    scheduleFrequency: 'weekly',
    storage,
  },
  projectSlug: 'sample-a',
});
assert.ok(providerCountCallsDuringGeneration > 0);
assert.ok(providerCountCallsDuringGeneration <= PREVIOUS_REPORT_CONTEXT_TRIM_MAX_TOKEN_COUNT_CALLS);
assert.equal(await resolveProviderCountTokens(createExtractiveReportProvider())('abc'), 3);

const countTokenWarnings: string[] = [];
const generateFailures: string[] = [];
let fallbackGenerateCalls = 0;
let fallbackCountTokensCalls = 0;
const fallbackProvider = createGeminiReportProviderWithExtractiveFallback({
  apiKey: 'test-key',
  fetchImpl: async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('countTokens')) {
      fallbackCountTokensCalls += 1;
    } else {
      fallbackGenerateCalls += 1;
    }
    return new Response('error', { status: 500 });
  },
  model: 'gemini-test',
  onCountTokensFailure: (message) => {
    countTokenWarnings.push(message);
  },
  onGenerateFailure: (message) => {
    generateFailures.push(message);
  },
});
assert.equal(await fallbackProvider.countTokens?.('abc'), 3);
assert.equal(countTokenWarnings.length, 1);
assert.equal(fallbackCountTokensCalls, 1);

const fallbackGenerated = await fallbackProvider.generate({
  documents: [
    {
      canonicalUri: 'https://example.com/issues/42',
      docType: 'issue',
      documentId: 'doc-issue',
      occurredAt: '2026-06-03T00:00:00.000Z',
      summary: 'Login failure risk',
      title: 'Issue #42 Login failure',
    },
  ],
  period: newPeriod,
  projectSlug: 'sample-a',
});
assert.equal(fallbackGenerateCalls, 1);
assert.equal(generateFailures.length, 1);
assert.match(generateFailures[0] ?? '', /HTTP 500/);
assert.equal(
  fallbackGenerated.title,
  `プロジェクト状況レポート ${newPeriod.start} - ${newPeriod.end}`,
);
assert.ok(fallbackGenerated.sections.some((section) => section.id === 'activity'));

console.log('report-recurrence-generation.test.ts: ok');
