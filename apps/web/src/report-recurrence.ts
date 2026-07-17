import { redactText } from './report-public-redaction.ts';
import type { ScheduledReportFrequency } from './report-schedules.ts';
import {
  assertProviderRecurrenceDeltaShape,
  type PrivateReportRecurrenceV1,
  type ProviderRecurrenceDelta,
  RECURRENCE_CHANGE_SUMMARY_MAX_CODE_POINTS,
  RECURRENCE_LIST_ITEM_MAX_CODE_POINTS,
  RECURRENCE_LIST_MAX_ITEMS,
  validatePrivateReportRecurrence,
} from './report-schema.ts';
import { normalizeReportWhitespace, truncateCodePoints } from './report-text.ts';

export function buildTrustedReportRecurrence(input: {
  readonly delta: ProviderRecurrenceDelta;
  readonly frequency: ScheduledReportFrequency;
  readonly previousReportId: string;
}): PrivateReportRecurrenceV1 {
  assertProviderRecurrenceDeltaShape(input.delta);
  const recurrence: PrivateReportRecurrenceV1 = {
    change_summary: sanitizeRecurrenceString(
      input.delta.change_summary,
      RECURRENCE_CHANGE_SUMMARY_MAX_CODE_POINTS,
    ),
    continued_items: sanitizeRecurrenceStringArray(input.delta.continued_items),
    decrements: sanitizeRecurrenceStringArray(input.delta.decrements),
    frequency: input.frequency,
    increments: sanitizeRecurrenceStringArray(input.delta.increments),
    previous_report_id: input.previousReportId,
  };
  if (recurrence.change_summary.length === 0) {
    throw new Error('Provider recurrence change_summary is empty after sanitization.');
  }
  validatePrivateReportRecurrence(recurrence);
  return recurrence;
}

export function hasProviderRecurrenceDelta(
  value: Partial<ProviderRecurrenceDelta> | null | undefined,
): value is ProviderRecurrenceDelta {
  if (value == null) {
    return false;
  }
  return (
    typeof value.change_summary === 'string' &&
    Array.isArray(value.increments) &&
    Array.isArray(value.decrements) &&
    Array.isArray(value.continued_items)
  );
}

function sanitizeRecurrenceStringArray(values: readonly string[]): string[] {
  return values
    .slice(0, RECURRENCE_LIST_MAX_ITEMS)
    .map((value) => sanitizeRecurrenceString(value, RECURRENCE_LIST_ITEM_MAX_CODE_POINTS))
    .filter(Boolean);
}

function sanitizeRecurrenceString(value: string, maxCodePoints: number): string {
  return truncateCodePoints(redactText(normalizeReportWhitespace(value)), maxCodePoints);
}
