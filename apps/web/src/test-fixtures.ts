import { buildContextualPufuScore } from './pufu-score-generation.ts';
import type { PufuScoreGenerationProvider } from './pufu-score-generator.ts';
import type { PufuScorePublicSection } from './pufu-score-input.ts';
import { normalizePufuScore, type PufuScoreSemanticV1 } from './pufu-score-schema.ts';
import type { PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    return Object.freeze(value);
  }
  return value;
}

export const sampleChatSource = deepFreeze({
  canonicalUri: 'https://example.com/spec',
  documentId: 'doc-a',
  docType: 'web_page',
  rawDocumentId: 'raw-a',
  title: 'Spec Update',
});

export const publicReportFixture: PublicReportJsonV1 = deepFreeze({
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
}) as PublicReportJsonV1;

export const publicContextBundleFixture: PublicContextBundleV1 = deepFreeze({
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
}) as PublicContextBundleV1;

/**
 * Deterministic test provider that mirrors legacy contextual pufu synthesis.
 */
export function createContextualPufuScoreGenerator(): PufuScoreGenerationProvider {
  return {
    async generate({ context }) {
      return buildContextualPufuScore({
        period: context.period,
        projectLabel: context.projectLabel,
        sections: context.reportSections as readonly PufuScorePublicSection[],
        sources: context.evidenceSources.map((source) => ({
          doc_type: source.docType,
          occurred_at: source.occurredAt,
          snippet: source.summary,
          title: source.title,
        })),
        summary: context.reportSummary,
        title: context.reportTitle,
      });
    },
  };
}

/**
 * Returns a fixed semantic score for deterministic report-generation tests.
 */
export function createFixedPufuScoreGenerator(
  score: PufuScoreSemanticV1,
): PufuScoreGenerationProvider {
  const normalized = normalizePufuScore(score);
  return {
    async generate() {
      return normalized;
    },
  };
}

/**
 * Provider that always rejects generation for failure-path regression tests.
 */
export function createRejectingPufuScoreGenerator(
  message = 'pufu score generation rejected',
): PufuScoreGenerationProvider {
  return {
    async generate() {
      throw new Error(message);
    },
  };
}

/**
 * Provider that resolves with an invalid semantic payload for normalization tests.
 */
export function createMalformedPufuScoreGenerator(): PufuScoreGenerationProvider {
  return {
    async generate() {
      return { gainingGoal: '不正なプ譜' } as PufuScoreSemanticV1;
    },
  };
}
