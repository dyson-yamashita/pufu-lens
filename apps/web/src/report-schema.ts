import {
  type CustomReportSnapshotV1,
  validateCustomReportSnapshot,
} from './custom-report-schema.ts';
import { type ProjectOverviewV1, validateProjectOverview } from './report-project-overview.ts';
import { isScheduledReportFrequency, type ScheduledReportFrequency } from './report-schedules.ts';

export type ReportPeriodKind = 'weekly';

export interface ReportPeriod {
  readonly end: string;
  readonly start: string;
}

export interface PrivateReportSource {
  readonly canonical_uri: string;
  readonly doc_type: string;
  readonly document_id: string;
  readonly snippet: string;
  readonly title?: string;
}

export interface PrivateReportPufuSource extends PrivateReportSource {
  readonly occurred_at: string | null;
  readonly title: string;
}

export interface PrivateReportSection {
  readonly id: 'activity' | 'issues' | 'progress' | 'risks';
  readonly items?: readonly Record<string, unknown>[];
  readonly markdown: string;
  readonly metrics?: Record<string, number>;
  readonly sources?: readonly PrivateReportSource[];
  readonly title: string;
}

export interface PrivateReportRecurrenceV1 {
  readonly change_summary: string;
  readonly continued_items: readonly string[];
  readonly decrements: readonly string[];
  readonly frequency: ScheduledReportFrequency;
  readonly increments: readonly string[];
  readonly previous_report_id: string;
}

export interface PrivateReportJsonV1 {
  readonly custom_layout?: CustomReportSnapshotV1;
  readonly generated_at: string;
  readonly period: ReportPeriod;
  readonly project_id: string;
  readonly project_overview?: ProjectOverviewV1;
  readonly pufu_sources?: readonly PrivateReportPufuSource[];
  readonly recurrence?: PrivateReportRecurrenceV1;
  readonly report_id: string;
  readonly schema_version: 'v1';
  readonly sections: readonly PrivateReportSection[];
  readonly summary: string;
  readonly title: string;
}

export interface PreparedReportChunk {
  readonly chunkIndex: number;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly metadata: Record<string, unknown>;
}

const PRIVATE_REPORT_SECTION_IDS = new Set<PrivateReportSection['id']>([
  'activity',
  'issues',
  'progress',
  'risks',
]);

export const RECURRENCE_CHANGE_SUMMARY_MAX_CODE_POINTS = 2_000;
export const RECURRENCE_LIST_MAX_ITEMS = 10;
export const RECURRENCE_LIST_ITEM_MAX_CODE_POINTS = 400;

export interface ProviderRecurrenceDelta {
  readonly change_summary: string;
  readonly continued_items: readonly string[];
  readonly decrements: readonly string[];
  readonly increments: readonly string[];
}

export function reportNowFromEnv(env?: NodeJS.ProcessEnv): Date | undefined {
  const value = env?.PUFU_LENS_REPORT_NOW?.trim();
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('PUFU_LENS_REPORT_NOW must be an ISO 8601 datetime.');
  }
  return date;
}

export function resolveReportPeriod(now: Date, periodKind: ReportPeriodKind): ReportPeriod {
  if (periodKind !== 'weekly') {
    throw new Error(`Unsupported report period: ${periodKind}`);
  }
  const day = now.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { end: formatDate(end), start: formatDate(start) };
}

export function validatePrivateReportJson(value: unknown): asserts value is PrivateReportJsonV1 {
  if (!isRecord(value)) {
    throw new Error('Report JSON must be an object.');
  }
  if (value.schema_version !== 'v1') {
    throw new Error('Report schema_version must be v1.');
  }
  for (const key of ['report_id', 'project_id', 'title', 'generated_at', 'summary']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Report ${key} must be a non-empty string.`);
    }
  }
  if (
    !isRecord(value.period) ||
    typeof value.period.start !== 'string' ||
    typeof value.period.end !== 'string'
  ) {
    throw new Error('Report period must include start and end.');
  }
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new Error('Report sections must be a non-empty array.');
  }
  if (value.pufu_sources !== undefined) {
    if (!Array.isArray(value.pufu_sources)) {
      throw new Error('Report pufu_sources must be an array.');
    }
    for (const source of value.pufu_sources) {
      if (
        !isRecord(source) ||
        typeof source.document_id !== 'string' ||
        typeof source.doc_type !== 'string' ||
        typeof source.title !== 'string' ||
        typeof source.snippet !== 'string' ||
        typeof source.canonical_uri !== 'string' ||
        (source.occurred_at !== null && typeof source.occurred_at !== 'string')
      ) {
        throw new Error('Report pufu source is invalid.');
      }
    }
  }
  if (value.custom_layout !== undefined) {
    validateCustomReportSnapshot(value.custom_layout);
  }
  if (value.recurrence !== undefined) {
    validatePrivateReportRecurrence(value.recurrence);
  }
  if (value.project_overview !== undefined) {
    validateProjectOverview(value.project_overview);
  }
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== 'string' || typeof section.title !== 'string') {
      throw new Error('Report section must include id and title.');
    }
    if (!isPrivateReportSectionId(section.id)) {
      throw new Error('Report section id is invalid.');
    }
    if (typeof section.markdown !== 'string') {
      throw new Error(`Report section ${section.id} markdown must be a string.`);
    }
    if (section.sources !== undefined) {
      if (!Array.isArray(section.sources)) {
        throw new Error(`Report section ${section.id} sources must be an array.`);
      }
      for (const source of section.sources) {
        if (
          !isRecord(source) ||
          typeof source.document_id !== 'string' ||
          typeof source.doc_type !== 'string' ||
          typeof source.snippet !== 'string' ||
          typeof source.canonical_uri !== 'string'
        ) {
          throw new Error(`Report section ${section.id} source is invalid.`);
        }
        if (source.title !== undefined && typeof source.title !== 'string') {
          throw new Error(`Report section ${section.id} source title must be a string.`);
        }
      }
    }
  }
}

export function validateGeneratedReport(
  value: Pick<PrivateReportJsonV1, 'sections' | 'summary' | 'title'> &
    Partial<ProviderRecurrenceDelta>,
  options?: { readonly requireRecurrence?: boolean },
): void {
  if (options?.requireRecurrence) {
    assertProviderRecurrenceDeltaShape(value);
  } else if (hasProviderRecurrenceFields(value)) {
    assertProviderRecurrenceDeltaShape(value);
  }
  const { sections, summary, title } = value;
  validatePrivateReportJson({
    generated_at: new Date().toISOString(),
    period: { end: '2026-01-04', start: '2025-12-29' },
    project_id: '00000000-0000-0000-0000-000000000000',
    report_id: '00000000-0000-0000-0000-000000000000',
    schema_version: 'v1',
    sections,
    summary,
    title,
  });
}

export function assertProviderRecurrenceDeltaShape(
  value: unknown,
): asserts value is ProviderRecurrenceDelta {
  if (!isRecord(value)) {
    throw new Error('Provider recurrence delta must be an object.');
  }
  if (typeof value.change_summary !== 'string' || value.change_summary.length === 0) {
    throw new Error('Provider recurrence change_summary must be a non-empty string.');
  }
  for (const field of ['increments', 'decrements', 'continued_items'] as const) {
    const list = value[field];
    if (!Array.isArray(list)) {
      throw new Error(`Provider recurrence ${field} must be an array.`);
    }
    for (const item of list) {
      if (typeof item !== 'string') {
        throw new Error(`Provider recurrence ${field} items must be strings.`);
      }
    }
  }
}

export function validatePrivateReportRecurrence(
  value: unknown,
): asserts value is PrivateReportRecurrenceV1 {
  if (!isRecord(value)) {
    throw new Error('Report recurrence must be an object.');
  }
  if (!isScheduledReportFrequency(value.frequency)) {
    throw new Error('Report recurrence frequency is invalid.');
  }
  if (typeof value.previous_report_id !== 'string' || value.previous_report_id.length === 0) {
    throw new Error('Report recurrence previous_report_id must be a non-empty string.');
  }
  if (typeof value.change_summary !== 'string') {
    throw new Error('Report recurrence change_summary must be a string.');
  }
  validateRecurrenceString(
    value.change_summary,
    'change_summary',
    RECURRENCE_CHANGE_SUMMARY_MAX_CODE_POINTS,
  );
  for (const field of ['increments', 'decrements', 'continued_items'] as const) {
    const list = value[field];
    if (!Array.isArray(list)) {
      throw new Error(`Report recurrence ${field} must be an array.`);
    }
    if (list.length > RECURRENCE_LIST_MAX_ITEMS) {
      throw new Error(`Report recurrence ${field} exceeds item limit.`);
    }
    for (const item of list) {
      if (typeof item !== 'string') {
        throw new Error(`Report recurrence ${field} items must be strings.`);
      }
      validateRecurrenceString(item, field, RECURRENCE_LIST_ITEM_MAX_CODE_POINTS);
    }
  }
}

function validateRecurrenceString(value: string, field: string, maxCodePoints: number): void {
  if (value.length === 0) {
    throw new Error(`Report recurrence ${field} must be a non-empty string.`);
  }
  if ([...value].length > maxCodePoints) {
    throw new Error(`Report recurrence ${field} exceeds code point limit.`);
  }
}

function hasProviderRecurrenceFields(
  value: Partial<ProviderRecurrenceDelta>,
): value is Partial<ProviderRecurrenceDelta> & Pick<ProviderRecurrenceDelta, 'change_summary'> {
  return (
    value.change_summary !== undefined ||
    value.increments !== undefined ||
    value.decrements !== undefined ||
    value.continued_items !== undefined
  );
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isPrivateReportSectionId(value: string): value is PrivateReportSection['id'] {
  return PRIVATE_REPORT_SECTION_IDS.has(value as PrivateReportSection['id']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
