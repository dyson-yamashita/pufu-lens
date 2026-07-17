import { isScheduledReportFrequency, type ScheduledReportFrequency } from './report-schedules.ts';

export class PartialScheduleInputError extends Error {
  constructor() {
    super(
      'previousScheduledReportId and scheduleFrequency must both be provided or both be omitted.',
    );
    this.name = 'PartialScheduleInputError';
  }
}

export function validatePairedScheduleInputs(input: {
  readonly previousScheduledReportId?: string | null;
  readonly scheduleFrequency?: ScheduledReportFrequency | null;
}):
  | {
      readonly previousScheduledReportId: string;
      readonly scheduleFrequency: ScheduledReportFrequency;
    }
  | undefined {
  const hasId =
    input.previousScheduledReportId !== undefined &&
    input.previousScheduledReportId !== null &&
    input.previousScheduledReportId.length > 0;
  const hasFrequency = input.scheduleFrequency !== undefined && input.scheduleFrequency !== null;
  if (!hasId && !hasFrequency) {
    return undefined;
  }
  if (!hasId || !hasFrequency || !isScheduledReportFrequency(input.scheduleFrequency)) {
    throw new PartialScheduleInputError();
  }
  return {
    previousScheduledReportId: input.previousScheduledReportId,
    scheduleFrequency: input.scheduleFrequency,
  };
}
