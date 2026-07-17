import {
  type DueScheduledReportPeriodEnumeration,
  enumerateDueScheduledReportPeriods,
} from '../../apps/web/src/report-schedule-periods.ts';
import {
  isScheduledReportFrequency,
  type ScheduledReportFrequency,
} from '../../apps/web/src/report-schedules.ts';

export interface DueMaterializeScheduleRow {
  readonly claimedAt: string;
  readonly frequency: ScheduledReportFrequency;
  readonly nextRunAt: string;
  readonly projectId: string;
  readonly scheduleId: string;
  readonly workerToken: string;
}

export function parseDueMaterializeScheduleRow(value: unknown): DueMaterializeScheduleRow | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid due materialize schedule row.');
  }
  const frequency = value.frequency;
  if (!isScheduledReportFrequency(frequency)) {
    throw new Error('Invalid due materialize schedule field: frequency');
  }
  return {
    claimedAt: requireTimestamp(value.claimedAt, 'claimedAt'),
    frequency,
    nextRunAt: requireTimestamp(value.nextRunAt, 'nextRunAt'),
    projectId: requireIdentifier(value.projectId, 'projectId'),
    scheduleId: requireIdentifier(value.scheduleId, 'scheduleId'),
    workerToken: requireIdentifier(value.workerToken, 'workerToken'),
  };
}

export function enumerateDueMaterializePeriods(input: {
  readonly asOf: Date | string;
  readonly frequency: ScheduledReportFrequency;
  readonly limit: number;
  readonly nextRunAt: Date | string;
}): DueScheduledReportPeriodEnumeration {
  return enumerateDueScheduledReportPeriods({
    asOf: input.asOf,
    frequency: input.frequency,
    limit: input.limit,
    nextRunAt: input.nextRunAt,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid due materialize schedule field: ${field}`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid due materialize schedule field: ${field}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid due materialize schedule field: ${field}`);
  }
  return date.toISOString();
}
