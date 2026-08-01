import type { PufuScoreSemanticV1 } from './pufu-score-schema.ts';
import type { ReportDocumentRecord } from './report-repository.ts';
import type { ReportPeriod } from './report-schema.ts';
import { truncateReportText } from './report-text.ts';

/** Bounded evidence fields passed into pufu generation without storage locators or IDs. */
export interface PufuScoreEvidenceSource {
  readonly docType: string;
  readonly occurredAt: string | null;
  readonly summary: string;
  readonly title: string;
}

/** Project-scoped context required to generate a contextual pufu score. */
export interface PufuScoreGenerationContext {
  readonly evidenceSources: readonly PufuScoreEvidenceSource[];
  readonly period: ReportPeriod;
  readonly projectLabel: string;
  readonly projectSlug: string;
  readonly reportSections: readonly {
    readonly id: string;
    readonly markdown: string;
    readonly title: string;
  }[];
  readonly reportSummary: string;
  readonly reportTitle: string;
  readonly totalCandidateCount: number;
}

/**
 * Generates a normalized `pufu-score-v1` payload from bounded project/report context.
 */
export interface PufuScoreGenerationProvider {
  generate(input: {
    readonly context: PufuScoreGenerationContext;
    readonly signal?: AbortSignal;
  }): Promise<PufuScoreSemanticV1>;
}

/**
 * Builds the bounded pufu generation context from report generation artifacts.
 */
export function buildPufuScoreGenerationContext(input: {
  readonly documents: readonly ReportDocumentRecord[];
  readonly generated: {
    readonly sections: readonly {
      readonly id: string;
      readonly markdown: string;
      readonly title: string;
    }[];
    readonly summary: string;
    readonly title: string;
  };
  readonly period: ReportPeriod;
  readonly projectSlug: string;
  readonly totalDocumentCount: number;
}): PufuScoreGenerationContext {
  return {
    evidenceSources: input.documents.map((document) => ({
      docType: document.docType,
      occurredAt: document.occurredAt,
      summary: truncateReportText(document.summary || document.title, 220),
      title: document.title,
    })),
    period: input.period,
    projectLabel: input.projectSlug,
    projectSlug: input.projectSlug,
    reportSections: input.generated.sections.map((section) => ({
      id: section.id,
      markdown: section.markdown,
      title: section.title,
    })),
    reportSummary: input.generated.summary,
    reportTitle: input.generated.title,
    totalCandidateCount: input.totalDocumentCount,
  };
}
