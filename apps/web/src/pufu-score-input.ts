import { redactSensitivePdfText } from './report-public-redaction.ts';
import type { PrivateReportJsonV1, PrivateReportSection, ReportPeriod } from './report-schema.ts';
import { normalizeReportWhitespace, truncateReportText } from './report-text.ts';

export interface PufuScorePublicSource {
  readonly doc_type: string;
  readonly occurred_at: string | null;
  readonly snippet: string;
  readonly title: string;
}

export interface PufuScorePublicSection {
  readonly id: PrivateReportSection['id'];
  readonly markdown: string;
  readonly title: string;
}

export type PufuScoreReportInput = {
  readonly period: ReportPeriod;
  readonly pufu_sources?: readonly PufuScorePublicSource[];
  readonly report_id: string;
  readonly sections: readonly PufuScorePublicSection[];
  readonly summary: string;
  readonly title: string;
};

const FORBIDDEN_PUFU_INPUT_KEYS = [
  'canonical_uri',
  'document_id',
  'items',
  'metrics',
  'project_id',
  'raw_document_id',
  'sources',
  'storage_uri',
] as const;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds a client-safe Pufu score input without private metadata or identifiers.
 */
export function toPufuScoreReportInput(
  report: PrivateReportJsonV1,
  options?: { readonly reportKey?: string },
): PufuScoreReportInput {
  const explicitSources = report.pufu_sources?.map(publicPufuSourceFromPrivate) ?? [];
  const sectionSources = report.sections.flatMap(sectionSourcesFromSection);
  const markdownSources = report.sections.flatMap(markdownSourceCandidates);
  const pufu_sources = dedupePublicSources([
    ...markdownSources,
    ...sectionSources,
    ...explicitSources,
  ]);
  const input: PufuScoreReportInput = {
    period: sanitizePufuPeriod(report.period),
    pufu_sources: pufu_sources.length > 0 ? pufu_sources : undefined,
    report_id: options?.reportKey ?? report.report_id,
    sections: report.sections.map(publicSectionFromPrivate),
    summary: sanitizePufuClientText(report.summary),
    title: sanitizePufuClientText(report.title),
  };
  assertPufuScoreReportInputSafe(input);
  return input;
}

/**
 * Asserts that a Pufu score input contains no private metadata or sensitive text.
 */
export function assertPufuScoreReportInputSafe(input: PufuScoreReportInput): void {
  const serialized = JSON.stringify(input);
  for (const key of FORBIDDEN_PUFU_INPUT_KEYS) {
    if (serialized.includes(`"${key}"`)) {
      throw new Error(`Pufu score input must not include ${key}.`);
    }
  }
}

function publicPufuSourceFromPrivate(
  source: NonNullable<PrivateReportJsonV1['pufu_sources']>[number],
): PufuScorePublicSource {
  return {
    doc_type: sanitizePufuClientText(source.doc_type),
    occurred_at: sanitizePufuOccurredAt(source.occurred_at),
    snippet: sanitizePufuClientText(truncateReportText(source.snippet, 220)),
    title: sanitizePufuClientText(truncateReportText(source.title, 120)),
  };
}

function sectionSourcesFromSection(section: PrivateReportSection): PufuScorePublicSource[] {
  return (section.sources ?? []).map((source) => ({
    doc_type: sanitizePufuClientText(source.doc_type),
    occurred_at: null,
    snippet: sanitizePufuClientText(truncateReportText(source.snippet, 220)),
    title: sanitizePufuClientText(truncateReportText(source.title || source.snippet, 120)),
  }));
}

function markdownSourceCandidates(section: PrivateReportSection): PufuScorePublicSource[] {
  if (section.id !== 'activity') {
    return [];
  }
  const sources: PufuScorePublicSource[] = [];
  section.markdown.split('\n').forEach((line) => {
    const parsed = parseMarkdownSourceLine(line);
    if (!parsed) {
      return;
    }
    sources.push({
      doc_type: 'report_source',
      occurred_at: null,
      snippet: sanitizePufuClientText(truncateReportText(parsed.snippet, 220)),
      title: sanitizePufuClientText(truncateReportText(parsed.title, 120)),
    });
  });
  return sources;
}

function parseMarkdownSourceLine(line: string): { snippet: string; title: string } | undefined {
  const trimmedStart = line.trimStart();
  const marker = trimmedStart[0];
  if (marker !== '-' && marker !== '*') {
    return undefined;
  }
  const rest = trimmedStart.slice(1);
  const content = rest.trimStart();
  if (rest.length === content.length) {
    return undefined;
  }
  const separatorIndex = content.indexOf(': ');
  if (separatorIndex <= 0 || separatorIndex >= content.length - 2) {
    return undefined;
  }
  return {
    snippet: content.slice(separatorIndex + 2),
    title: content.slice(0, separatorIndex),
  };
}

function publicSectionFromPrivate(section: PrivateReportSection): PufuScorePublicSection {
  return {
    id: section.id,
    markdown: sanitizePufuClientText(section.markdown),
    title: sanitizePufuClientText(section.title),
  };
}

function sanitizePufuPeriod(period: ReportPeriod): ReportPeriod {
  return {
    end: sanitizePufuPeriodDate(period.end, 'end'),
    start: sanitizePufuPeriodDate(period.start, 'start'),
  };
}

function sanitizePufuPeriodDate(value: string, field: 'end' | 'start'): string {
  const sanitized = sanitizePufuClientText(value);
  if (!ISO_DATE_PATTERN.test(sanitized)) {
    throw new Error(`Pufu score input period ${field} is invalid.`);
  }
  const parsed = new Date(`${sanitized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== sanitized) {
    throw new Error(`Pufu score input period ${field} is invalid.`);
  }
  return sanitized;
}

function sanitizePufuOccurredAt(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const sanitized = sanitizePufuClientText(value);
  if (!sanitized) {
    return null;
  }
  const parsed = Date.parse(sanitized);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return sanitized;
}

function sanitizePufuClientText(value: string): string {
  return redactSensitivePdfText(normalizeReportWhitespace(value));
}

function dedupePublicSources(sources: readonly PufuScorePublicSource[]): PufuScorePublicSource[] {
  const seen = new Set<string>();
  const deduped: PufuScorePublicSource[] = [];
  for (const source of sources) {
    const title = normalizeReportWhitespace(source.title);
    const snippet = normalizeReportWhitespace(source.snippet);
    if (!title && !snippet) {
      continue;
    }
    const key = `${title}:${snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      doc_type: source.doc_type,
      occurred_at: source.occurred_at,
      snippet,
      title: title || snippet,
    });
  }
  return deduped;
}
