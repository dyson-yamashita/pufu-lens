import type { ReportScheduleFrequency, ScheduledReportFrequency } from './report-schedules.ts';

const TOKYO_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;
export const MAX_REPORT_PERIOD_ENUMERATION = 500;

export interface ScheduledReportPeriod {
  readonly end: string;
  readonly start: string;
}

export interface DueScheduledReportPeriod extends ScheduledReportPeriod {
  readonly scheduledFor: string;
}

export interface DueScheduledReportPeriodEnumeration {
  readonly hasMore: boolean;
  readonly nextRunAt: string;
  readonly periods: readonly DueScheduledReportPeriod[];
}

export interface BackfillScheduledReportPeriodEnumeration {
  readonly hasMore: boolean;
  readonly nextPeriodStart: string | null;
  readonly periods: readonly ScheduledReportPeriod[];
}

export function resolveScheduledReportPeriod(
  scheduledFor: Date | string,
  frequency: ScheduledReportFrequency,
): ScheduledReportPeriod {
  const localSlot = tokyoLocalDateTime(requireInstant(scheduledFor, 'scheduledFor'));
  requireCanonicalScheduleSlot(localSlot, frequency);

  if (frequency === 'weekly') {
    const start = addLocalDays(localSlot, -7);
    return { end: formatLocalDate(addLocalDays(localSlot, -1)), start: formatLocalDate(start) };
  }
  if (frequency === 'monthly') {
    const start = new Date(Date.UTC(localSlot.getUTCFullYear(), localSlot.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(localSlot.getUTCFullYear(), localSlot.getUTCMonth(), 0));
    return { end: formatLocalDate(end), start: formatLocalDate(start) };
  }
  if (frequency === 'annually') {
    const year = localSlot.getUTCFullYear() - 1;
    return { end: `${year}-12-31`, start: `${year}-01-01` };
  }
  return assertNever(frequency);
}

export function resolveNextScheduledReportRunAt(input: {
  readonly asOf: Date | string;
  readonly frequency: ScheduledReportFrequency;
  readonly runTime: string;
}): string {
  const asOf = requireInstant(input.asOf, 'asOf');
  const [hour, minute] = requireRunTime(input.runTime);
  const localNow = tokyoLocalDateTime(asOf);
  let candidate: Date;

  if (input.frequency === 'weekly') {
    const daysUntilMonday = (8 - localNow.getUTCDay()) % 7;
    candidate = new Date(
      Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate() + daysUntilMonday,
        hour,
        minute,
      ),
    );
    if (candidate.valueOf() <= localNow.valueOf()) candidate.setUTCDate(candidate.getUTCDate() + 7);
  } else if (input.frequency === 'monthly') {
    candidate = new Date(
      Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), 1, hour, minute),
    );
    if (candidate.valueOf() <= localNow.valueOf())
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
  } else {
    candidate = new Date(Date.UTC(localNow.getUTCFullYear(), 0, 1, hour, minute));
    if (candidate.valueOf() <= localNow.valueOf()) {
      candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
    }
  }
  return new Date(candidate.valueOf() - TOKYO_OFFSET_MILLISECONDS).toISOString();
}

export function enumerateDueScheduledReportPeriods(input: {
  readonly asOf: Date | string;
  readonly frequency: ScheduledReportFrequency;
  readonly limit: number;
  readonly nextRunAt: Date | string;
}): DueScheduledReportPeriodEnumeration {
  const asOf = requireInstant(input.asOf, 'asOf');
  let slot = requireInstant(input.nextRunAt, 'nextRunAt');
  const limit = requireEnumerationLimit(input.limit);
  const periods: DueScheduledReportPeriod[] = [];

  requireCanonicalScheduleSlot(tokyoLocalDateTime(slot), input.frequency);
  while (slot.valueOf() <= asOf.valueOf() && periods.length < limit) {
    periods.push({
      ...resolveScheduledReportPeriod(slot, input.frequency),
      scheduledFor: slot.toISOString(),
    });
    slot = advanceScheduleSlot(slot, input.frequency);
  }

  return {
    hasMore: slot.valueOf() <= asOf.valueOf(),
    nextRunAt: slot.toISOString(),
    periods,
  };
}

export function enumerateBackfillScheduledReportPeriods(input: {
  readonly asOf: Date | string;
  readonly availableFrom: string;
  readonly frequency: ScheduledReportFrequency;
  readonly limit: number;
  readonly periodStartCursor?: string;
}): BackfillScheduledReportPeriodEnumeration {
  const limit = requireEnumerationLimit(input.limit);
  const firstPeriodStart = periodContainingDate(
    requireDate(input.availableFrom, 'availableFrom'),
    input.frequency,
  ).start;
  const currentPeriodStart = periodContainingDate(
    formatLocalDate(tokyoLocalDateTime(requireInstant(input.asOf, 'asOf'))),
    input.frequency,
  ).start;
  let periodStart = input.periodStartCursor
    ? requireCanonicalPeriodStart(input.periodStartCursor, input.frequency)
    : firstPeriodStart;
  if (periodStart < firstPeriodStart) {
    throw new Error('periodStartCursor cannot precede the first backfill period.');
  }

  const periods: ScheduledReportPeriod[] = [];
  while (periodStart < currentPeriodStart && periods.length < limit) {
    const period = periodStartingAt(periodStart, input.frequency);
    periods.push(period);
    periodStart = nextPeriodStart(periodStart, input.frequency);
  }
  const hasMore = periodStart < currentPeriodStart;
  return {
    hasMore,
    nextPeriodStart: hasMore ? periodStart : null,
    periods,
  };
}

export function shouldEnqueueInitialReportBackfill(input: {
  readonly hasScheduledReportForFrequency: boolean;
  readonly nextFrequency: ReportScheduleFrequency;
  readonly previousFrequency: ReportScheduleFrequency | null;
}): boolean {
  return (
    (input.previousFrequency === null || input.previousFrequency === 'none') &&
    input.nextFrequency !== 'none' &&
    !input.hasScheduledReportForFrequency
  );
}

function assertNever(value: never): never {
  throw new Error(`Unsupported report schedule frequency: ${String(value)}`);
}

function advanceScheduleSlot(slot: Date, frequency: ScheduledReportFrequency): Date {
  const localSlot = tokyoLocalDateTime(slot);
  if (frequency === 'weekly') {
    localSlot.setUTCDate(localSlot.getUTCDate() + 7);
  } else if (frequency === 'monthly') {
    localSlot.setUTCMonth(localSlot.getUTCMonth() + 1);
  } else {
    localSlot.setUTCFullYear(localSlot.getUTCFullYear() + 1);
  }
  return new Date(localSlot.valueOf() - TOKYO_OFFSET_MILLISECONDS);
}

function periodContainingDate(
  date: string,
  frequency: ScheduledReportFrequency,
): ScheduledReportPeriod {
  const localDate = localDateFromString(date);
  if (frequency === 'weekly') {
    const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
    const start = addLocalDays(localDate, -daysSinceMonday);
    return { end: formatLocalDate(addLocalDays(start, 6)), start: formatLocalDate(start) };
  }
  if (frequency === 'monthly') {
    const start = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), 1));
    const end = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, 0));
    return { end: formatLocalDate(end), start: formatLocalDate(start) };
  }
  const year = localDate.getUTCFullYear();
  return { end: `${year}-12-31`, start: `${year}-01-01` };
}

function periodStartingAt(
  periodStart: string,
  frequency: ScheduledReportFrequency,
): ScheduledReportPeriod {
  const start = localDateFromString(periodStart);
  if (frequency === 'weekly') {
    return { end: formatLocalDate(addLocalDays(start, 6)), start: periodStart };
  }
  if (frequency === 'monthly') {
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return { end: formatLocalDate(end), start: periodStart };
  }
  return { end: `${start.getUTCFullYear()}-12-31`, start: periodStart };
}

function nextPeriodStart(periodStart: string, frequency: ScheduledReportFrequency): string {
  const start = localDateFromString(periodStart);
  if (frequency === 'weekly') start.setUTCDate(start.getUTCDate() + 7);
  else if (frequency === 'monthly') start.setUTCMonth(start.getUTCMonth() + 1);
  else start.setUTCFullYear(start.getUTCFullYear() + 1);
  return formatLocalDate(start);
}

function requireCanonicalPeriodStart(value: string, frequency: ScheduledReportFrequency): string {
  const date = requireDate(value, 'periodStartCursor');
  if (periodContainingDate(date, frequency).start !== date) {
    throw new Error('periodStartCursor must be a canonical period boundary.');
  }
  return date;
}

function requireCanonicalScheduleSlot(localSlot: Date, frequency: ScheduledReportFrequency): void {
  if (frequency === 'weekly' && localSlot.getUTCDay() !== 1) {
    throw new Error('weekly scheduledFor must fall on Monday in Asia/Tokyo.');
  }
  if (frequency === 'monthly' && localSlot.getUTCDate() !== 1) {
    throw new Error('monthly scheduledFor must fall on the first day in Asia/Tokyo.');
  }
  if (frequency === 'annually' && (localSlot.getUTCMonth() !== 0 || localSlot.getUTCDate() !== 1)) {
    throw new Error('annually scheduledFor must fall on January 1 in Asia/Tokyo.');
  }
}

function requireEnumerationLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REPORT_PERIOD_ENUMERATION) {
    throw new Error(`limit must be between 1 and ${MAX_REPORT_PERIOD_ENUMERATION}.`);
  }
  return value;
}

function requireRunTime(value: string): readonly [number, number] {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw new Error('runTime must use HH:mm or HH:mm:ss.');
  return [Number(match[1]), Number(match[2])];
}

function requireInstant(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} must be a valid instant.`);
  return date;
}

function requireDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD.`);
  const date = localDateFromString(value);
  if (Number.isNaN(date.valueOf()) || formatLocalDate(date) !== value) {
    throw new Error(`${field} must be a valid date.`);
  }
  return value;
}

function localDateFromString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function tokyoLocalDateTime(instant: Date): Date {
  return new Date(instant.valueOf() + TOKYO_OFFSET_MILLISECONDS);
}

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date.valueOf());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatLocalDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
