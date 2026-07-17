import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { ReportRepository } from './report-repository.ts';
import type { ScheduledReportFrequency } from './report-schedules.ts';
import {
  type PrivateReportJsonV1,
  type ReportPeriod,
  validatePrivateReportJson,
} from './report-schema.ts';

export {
  PartialScheduleInputError,
  validatePairedScheduleInputs,
} from './report-schedule-input.ts';

export class PreviousScheduledReportNotFoundError extends Error {
  readonly reportId: string;

  constructor(reportId: string) {
    super(`Previous scheduled report not found: ${reportId}`);
    this.name = 'PreviousScheduledReportNotFoundError';
    this.reportId = reportId;
  }
}

/**
 * Loads and validates a previous scheduled report using trusted project-scoped metadata.
 */
export async function loadTrustedPreviousScheduledReport(input: {
  readonly newPeriod: ReportPeriod;
  readonly previousScheduledReportId: string;
  readonly projectId: string;
  readonly repository: Pick<ReportRepository, 'readReportMetadata'>;
  readonly scheduleFrequency: ScheduledReportFrequency;
  readonly storage: ObjectStorage;
}): Promise<PrivateReportJsonV1> {
  const metadata = await input.repository.readReportMetadata({
    projectId: input.projectId,
    reportId: input.previousScheduledReportId,
  });
  if (!metadata) {
    throw new PreviousScheduledReportNotFoundError(input.previousScheduledReportId);
  }
  if (metadata.generationKind !== 'scheduled' && metadata.generationKind !== 'scheduled_backfill') {
    throw new PreviousScheduledReportNotFoundError(input.previousScheduledReportId);
  }
  if (metadata.scheduleFrequency !== input.scheduleFrequency) {
    throw new PreviousScheduledReportNotFoundError(input.previousScheduledReportId);
  }
  if (!isPeriodStrictlyBefore(metadata.period, input.newPeriod)) {
    throw new PreviousScheduledReportNotFoundError(input.previousScheduledReportId);
  }

  const stored = JSON.parse(await input.storage.getText(metadata.storageUri)) as unknown;
  validatePrivateReportJson(stored);
  if (
    stored.report_id !== input.previousScheduledReportId ||
    stored.project_id !== input.projectId ||
    stored.period.start !== metadata.period.start ||
    stored.period.end !== metadata.period.end ||
    !isPeriodStrictlyBefore(stored.period, input.newPeriod)
  ) {
    throw new PreviousScheduledReportNotFoundError(input.previousScheduledReportId);
  }
  return stored;
}

function isPeriodStrictlyBefore(previous: ReportPeriod, next: ReportPeriod): boolean {
  return previous.end < next.start;
}
