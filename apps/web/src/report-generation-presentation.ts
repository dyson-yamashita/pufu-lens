import { reportScheduleFrequencyLabel } from './report-schedule-presentation.ts';
import type { ScheduledReportFrequency } from './report-schedules.ts';

type ReportGenerationKind = 'manual' | 'scheduled' | 'scheduled_backfill';

/**
 * Formats report generation metadata for the private report list.
 *
 * @param generationKind - Whether the report was generated manually, on schedule, or by backfill
 * @param scheduleFrequency - The scheduled cadence, or `null` for a manual report
 * @returns A Japanese label describing the generation source and cadence
 */
export function reportGenerationLabel(
  generationKind: ReportGenerationKind,
  scheduleFrequency: ScheduledReportFrequency | null,
): string {
  if (generationKind === 'manual') {
    return '手動';
  }

  const frequencyLabel = scheduleFrequency
    ? reportScheduleFrequencyLabel(scheduleFrequency)
    : '周期不明';
  return generationKind === 'scheduled_backfill'
    ? `定期 backfill（${frequencyLabel}）`
    : `定期（${frequencyLabel}）`;
}
