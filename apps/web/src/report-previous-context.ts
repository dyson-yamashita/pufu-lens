import { redactText } from './report-public-redaction.ts';
import type { ScheduledReportFrequency } from './report-schedules.ts';
import type { PrivateReportJsonV1, PrivateReportPufuSource } from './report-schema.ts';
import { countCodePoints, normalizeReportWhitespace, truncateCodePoints } from './report-text.ts';

export const PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS = 16_000;
export const PREVIOUS_REPORT_CONTEXT_MAX_TOKENS = 6_000;
export const PREVIOUS_REPORT_SUMMARY_MAX_CODE_POINTS = 2_000;
export const PREVIOUS_REPORT_CONTINUED_RISK_MAX_ITEMS = 10;
export const PREVIOUS_REPORT_CONTINUED_RISK_MAX_CODE_POINTS = 400;
export const PREVIOUS_REPORT_SECTION_MAX_ITEMS = 10;
export const PREVIOUS_REPORT_SECTION_TITLE_MAX_CODE_POINTS = 120;
export const PREVIOUS_REPORT_SECTION_SUMMARY_MAX_CODE_POINTS = 600;
export const PREVIOUS_REPORT_SOURCE_MAX_ITEMS = 20;
export const PREVIOUS_REPORT_SOURCE_TITLE_MAX_CODE_POINTS = 160;
export const PREVIOUS_REPORT_SOURCE_SNIPPET_MAX_CODE_POINTS = 400;
export const PREVIOUS_REPORT_SOURCE_DOC_TYPE_MAX_CODE_POINTS = 80;
export const PREVIOUS_REPORT_SOURCE_OCCURRED_AT_MAX_CODE_POINTS = 40;
export const PREVIOUS_REPORT_CONTEXT_TRIM_MAX_TOKEN_COUNT_CALLS = 36;

export interface PreviousReportContextSource {
  readonly docType: string;
  readonly occurredAt: string | null;
  readonly snippet: string;
  readonly title: string;
}

export interface PreviousReportContextSection {
  readonly summary: string;
  readonly title: string;
}

export interface PreviousReportContextPayload {
  readonly continuedRisks: readonly string[];
  readonly frequency: ScheduledReportFrequency;
  readonly previousReportId: string;
  readonly sections: readonly PreviousReportContextSection[];
  readonly sources: readonly PreviousReportContextSource[];
  readonly summary: string;
}

export interface PreviousReportProviderContext {
  readonly frequency: ScheduledReportFrequency;
  readonly payload: PreviousReportContextPayload;
  readonly previousReportId: string;
  readonly serialized: string;
}

export function countProviderTokensConservative(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Builds a bounded, redacted, deterministic provider context from a trusted previous report.
 */
export async function buildPreviousReportProviderContext(input: {
  readonly countTokens?: (text: string) => Promise<number>;
  readonly frequency: ScheduledReportFrequency;
  readonly previousReport: PrivateReportJsonV1;
  readonly previousReportId: string;
}): Promise<PreviousReportProviderContext> {
  const payload = buildInitialPreviousReportContextPayload({
    frequency: input.frequency,
    previousReport: input.previousReport,
    previousReportId: input.previousReportId,
  });
  const countTokens = input.countTokens ?? (async (text) => countProviderTokensConservative(text));
  const { payload: trimmed } = await trimPreviousReportContextPayload(payload, countTokens);
  const serialized = serializePreviousReportContext(trimmed);
  if (countCodePoints(serialized) > PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS) {
    throw new Error('Previous report context exceeds provider code point budget after trimming.');
  }
  const finalTokenCount = await countTokens(serialized);
  if (finalTokenCount > PREVIOUS_REPORT_CONTEXT_MAX_TOKENS) {
    throw new Error('Previous report context exceeds provider token budget after trimming.');
  }
  return {
    frequency: input.frequency,
    payload: trimmed,
    previousReportId: input.previousReportId,
    serialized,
  };
}

export function serializePreviousReportContext(payload: PreviousReportContextPayload): string {
  return JSON.stringify({
    continued_risks: payload.continuedRisks,
    frequency: payload.frequency,
    previous_report_id: payload.previousReportId,
    sections: payload.sections.map((section) => ({
      summary: section.summary,
      title: section.title,
    })),
    sources: payload.sources.map((source) => ({
      doc_type: source.docType,
      occurred_at: source.occurredAt,
      snippet: source.snippet,
      title: source.title,
    })),
    summary: payload.summary,
  });
}

export function extractContinuedRisks(report: PrivateReportJsonV1): readonly string[] {
  const risksSection = report.sections.find((section) => section.id === 'risks');
  if (!risksSection) {
    return [];
  }
  const values: string[] = [];
  if (Array.isArray(risksSection.items)) {
    for (const item of risksSection.items) {
      const title = typeof item.title === 'string' ? item.title : '';
      if (title) {
        values.push(title);
      }
    }
  }
  for (const line of risksSection.markdown.split('\n')) {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^([-+*])\s+(.+)$/);
    if (!bulletMatch?.[2]) {
      continue;
    }
    const bullet = bulletMatch[2].trim();
    if (bullet) {
      values.push(bullet);
    }
  }
  return uniqueNonEmpty(values.map((value) => normalizeReportWhitespace(value)).filter(Boolean));
}

function buildInitialPreviousReportContextPayload(input: {
  readonly frequency: ScheduledReportFrequency;
  readonly previousReport: PrivateReportJsonV1;
  readonly previousReportId: string;
}): PreviousReportContextPayload {
  return {
    continuedRisks: extractContinuedRisks(input.previousReport)
      .slice(0, PREVIOUS_REPORT_CONTINUED_RISK_MAX_ITEMS)
      .map((value) =>
        truncateCodePoints(
          redactText(normalizeReportWhitespace(value)),
          PREVIOUS_REPORT_CONTINUED_RISK_MAX_CODE_POINTS,
        ),
      ),
    frequency: input.frequency,
    previousReportId: input.previousReportId,
    sections: input.previousReport.sections
      .slice(0, PREVIOUS_REPORT_SECTION_MAX_ITEMS)
      .map((section) => ({
        summary: truncateCodePoints(
          redactText(normalizeReportWhitespace(section.markdown)),
          PREVIOUS_REPORT_SECTION_SUMMARY_MAX_CODE_POINTS,
        ),
        title: truncateCodePoints(
          redactText(normalizeReportWhitespace(section.title)),
          PREVIOUS_REPORT_SECTION_TITLE_MAX_CODE_POINTS,
        ),
      })),
    sources: sortPreviousReportSources(input.previousReport.pufu_sources ?? [])
      .slice(0, PREVIOUS_REPORT_SOURCE_MAX_ITEMS)
      .map(sourceToContextSource),
    summary: truncateCodePoints(
      redactText(normalizeReportWhitespace(input.previousReport.summary)),
      PREVIOUS_REPORT_SUMMARY_MAX_CODE_POINTS,
    ),
  };
}

async function trimPreviousReportContextPayload(
  payload: PreviousReportContextPayload,
  countTokens: (text: string) => Promise<number>,
): Promise<{ readonly payload: PreviousReportContextPayload; readonly tokenCountCalls: number }> {
  let tokenCountCalls = 0;
  const measureTokens = async (text: string): Promise<number> => {
    tokenCountCalls += 1;
    return countTokens(text);
  };
  let current = clonePayload(payload);
  current = await trimCollectionByBinarySearch({
    countTokens: measureTokens,
    getPayload: (count) => ({ ...current, sources: current.sources.slice(0, count) }),
    getSerialized: (candidate) => serializePreviousReportContext(candidate),
    maxCount: current.sources.length,
  });
  if (await fitsPreviousReportContextBudget(current, measureTokens)) {
    return { payload: current, tokenCountCalls };
  }
  current = await trimCollectionByBinarySearch({
    countTokens: measureTokens,
    getPayload: (count) => ({ ...current, sections: current.sections.slice(0, count) }),
    getSerialized: (candidate) => serializePreviousReportContext(candidate),
    maxCount: current.sections.length,
  });
  if (await fitsPreviousReportContextBudget(current, measureTokens)) {
    return { payload: current, tokenCountCalls };
  }
  current = await trimCollectionByBinarySearch({
    countTokens: measureTokens,
    getPayload: (count) => ({
      ...current,
      continuedRisks: current.continuedRisks.slice(0, count),
    }),
    getSerialized: (candidate) => serializePreviousReportContext(candidate),
    maxCount: current.continuedRisks.length,
  });
  if (await fitsPreviousReportContextBudget(current, measureTokens)) {
    return { payload: current, tokenCountCalls };
  }
  current = await trimSummaryByBinarySearch(current, measureTokens);
  return { payload: current, tokenCountCalls };
}

async function trimCollectionByBinarySearch(input: {
  readonly countTokens: (text: string) => Promise<number>;
  readonly getPayload: (count: number) => PreviousReportContextPayload;
  readonly getSerialized: (payload: PreviousReportContextPayload) => string;
  readonly maxCount: number;
}): Promise<PreviousReportContextPayload> {
  if (input.maxCount === 0) {
    return input.getPayload(0);
  }
  let low = 0;
  let high = input.maxCount;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = input.getPayload(mid);
    if (await fitsSerializedBudget(input.getSerialized(candidate), input.countTokens)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return input.getPayload(best);
}

async function trimSummaryByBinarySearch(
  payload: PreviousReportContextPayload,
  countTokens: (text: string) => Promise<number>,
): Promise<PreviousReportContextPayload> {
  const maxCodePoints = countCodePoints(payload.summary);
  if (maxCodePoints === 0) {
    return payload;
  }
  let low = 1;
  let high = maxCodePoints;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = {
      ...payload,
      summary: truncateCodePoints(payload.summary, mid),
    };
    if (await fitsPreviousReportContextBudget(candidate, countTokens)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return {
    ...payload,
    summary: truncateCodePoints(payload.summary, best),
  };
}

async function fitsSerializedBudget(
  serialized: string,
  countTokens: (text: string) => Promise<number>,
): Promise<boolean> {
  return (
    countCodePoints(serialized) <= PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS &&
    (await countTokens(serialized)) <= PREVIOUS_REPORT_CONTEXT_MAX_TOKENS
  );
}

async function fitsPreviousReportContextBudget(
  payload: PreviousReportContextPayload,
  countTokens: (text: string) => Promise<number>,
): Promise<boolean> {
  const serialized = serializePreviousReportContext(payload);
  return (
    countCodePoints(serialized) <= PREVIOUS_REPORT_CONTEXT_MAX_CODE_POINTS &&
    (await countTokens(serialized)) <= PREVIOUS_REPORT_CONTEXT_MAX_TOKENS
  );
}

function clonePayload(payload: PreviousReportContextPayload): PreviousReportContextPayload {
  return {
    continuedRisks: [...payload.continuedRisks],
    frequency: payload.frequency,
    previousReportId: payload.previousReportId,
    sections: payload.sections.map((section) => ({ ...section })),
    sources: payload.sources.map((source) => ({ ...source })),
    summary: payload.summary,
  };
}

function sortPreviousReportSources(
  sources: readonly PrivateReportPufuSource[],
): readonly PrivateReportPufuSource[] {
  return [...sources].sort((left, right) => {
    const leftOccurred = left.occurred_at ?? '';
    const rightOccurred = right.occurred_at ?? '';
    if (leftOccurred !== rightOccurred) {
      return rightOccurred.localeCompare(leftOccurred);
    }
    return left.document_id.localeCompare(right.document_id);
  });
}

function sourceToContextSource(source: PrivateReportPufuSource): PreviousReportContextSource {
  return {
    docType: truncateCodePoints(
      redactText(normalizeReportWhitespace(source.doc_type)),
      PREVIOUS_REPORT_SOURCE_DOC_TYPE_MAX_CODE_POINTS,
    ),
    occurredAt: sanitizePreviousReportOccurredAt(source.occurred_at),
    snippet: truncateCodePoints(
      redactText(normalizeReportWhitespace(source.snippet)),
      PREVIOUS_REPORT_SOURCE_SNIPPET_MAX_CODE_POINTS,
    ),
    title: truncateCodePoints(
      redactText(normalizeReportWhitespace(source.title)),
      PREVIOUS_REPORT_SOURCE_TITLE_MAX_CODE_POINTS,
    ),
  };
}

function sanitizePreviousReportOccurredAt(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return truncateCodePoints(
    redactText(normalizeReportWhitespace(value)),
    PREVIOUS_REPORT_SOURCE_OCCURRED_AT_MAX_CODE_POINTS,
  );
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values)];
}
