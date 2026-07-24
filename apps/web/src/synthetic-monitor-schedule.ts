import type { SyntheticMonitorScheduleStageObservation } from './synthetic-monitor-contract.ts';
import type { SyntheticMonitorScheduleRecord } from './synthetic-monitor-service.ts';

/**
 * Aggregates multiple source schedule rows into one deterministic stage observation.
 *
 * @param schedules - Schedule rows linked to a logical source.
 * @param nowMs - Current timestamp used for due and active lease evaluation.
 * @returns Aggregated schedule stage status.
 */
export function aggregateScheduleStageObservation(
  schedules: readonly SyntheticMonitorScheduleRecord[],
  nowMs: number = Date.now(),
): SyntheticMonitorScheduleStageObservation {
  if (schedules.length === 0) {
    return { status: 'not_found', enabled: false, retryCount: 0, nextRunDue: false };
  }
  const enabled = schedules.some((schedule) => schedule.enabled);
  const retryCount = schedules.reduce((max, schedule) => Math.max(max, schedule.retryCount), 0);
  const nextRunDue = computeSourceScheduleNextRunDue(schedules, nowMs);
  if (!enabled) {
    return { status: 'ok', enabled: false, retryCount, nextRunDue: false };
  }
  if (retryCount > 0) {
    return { status: 'failed', enabled: true, retryCount, nextRunDue };
  }
  const hasActiveLease = schedules.some(
    (schedule) =>
      schedule.enabled &&
      schedule.leaseExpiresAt !== null &&
      Date.parse(schedule.leaseExpiresAt) > nowMs,
  );
  if (hasActiveLease || nextRunDue) {
    return { status: 'pending', enabled: true, retryCount, nextRunDue };
  }
  return { status: 'ok', enabled: true, retryCount, nextRunDue: false };
}

function computeSourceScheduleNextRunDue(
  schedules: readonly SyntheticMonitorScheduleRecord[],
  nowMs: number,
): boolean {
  return schedules.some(
    (schedule) =>
      schedule.enabled && schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) <= nowMs,
  );
}
