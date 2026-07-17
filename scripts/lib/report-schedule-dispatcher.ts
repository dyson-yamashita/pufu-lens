import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  ReportScheduleRunKind,
  ScheduledReportFrequency,
} from '../../apps/web/src/report-schedules.ts';

const DEFAULT_CLAIM_LIMIT = 10;
const DEFAULT_MATERIALIZE_LIMIT = 10;
const DEFAULT_MAX_RUNTIME_MS = 45 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const REPORT_SCHEDULE_RUNTIME_EXCEEDED_ERROR = 'report schedule dispatcher runtime exceeded';

export interface ReportScheduleRunTarget {
  readonly frequency: ScheduledReportFrequency;
  readonly periodEnd: string;
  readonly periodRunId: string;
  readonly periodStart: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly runKind: ReportScheduleRunKind;
  readonly scheduleId: string;
}

export interface ReportScheduleRunOutcome {
  readonly reportId?: string;
  readonly skipReason?: string;
  readonly type: 'report' | 'skipped';
}

export interface ReportScheduleDispatcherRepository {
  claimRunnable(input: {
    readonly limit: number;
    readonly workerToken: string;
  }): Promise<readonly ReportScheduleRunTarget[]>;
  heartbeat(input: {
    readonly periodRunId: string;
    readonly workerToken: string;
  }): Promise<boolean>;
  markFailed(input: {
    readonly error: string;
    readonly periodRunId: string;
    readonly workerToken: string;
  }): Promise<boolean>;
  markSkipped(input: {
    readonly periodRunId: string;
    readonly skipReason: string;
    readonly workerToken: string;
  }): Promise<boolean>;
  markSucceeded(input: {
    readonly periodRunId: string;
    readonly reportId: string;
    readonly workerToken: string;
  }): Promise<boolean>;
  materializeDue(input: { readonly limit: number }): Promise<number>;
}

export interface ReportScheduleRunner {
  run(target: ReportScheduleRunTarget, signal: AbortSignal): Promise<ReportScheduleRunOutcome>;
}

export interface ReportScheduleDispatchResult {
  readonly claimed: number;
  readonly failed: number;
  readonly leaseLost: number;
  readonly materialized: number;
  readonly skipped: number;
  readonly succeeded: number;
}

export async function dispatchReportSchedules(input: {
  readonly claimLimit?: number;
  readonly heartbeatIntervalMs?: number;
  readonly materializeLimit?: number;
  readonly maxRuntimeMs?: number;
  readonly now?: () => number;
  readonly repository: ReportScheduleDispatcherRepository;
  readonly runner: ReportScheduleRunner;
  readonly workerToken?: string;
}): Promise<ReportScheduleDispatchResult> {
  const workerToken = input.workerToken ?? randomUUID();
  const claimLimit = input.claimLimit ?? DEFAULT_CLAIM_LIMIT;
  const materializeLimit = input.materializeLimit ?? DEFAULT_MATERIALIZE_LIMIT;
  const maxRuntimeMs = input.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const now = input.now ?? (() => performance.now());
  const deadline = now() + maxRuntimeMs;
  const materialized = await input.repository.materializeDue({ limit: materializeLimit });
  let claimed = 0;
  let failed = 0;
  let leaseLost = 0;
  let skipped = 0;
  let succeeded = 0;

  while (claimed < claimLimit && now() < deadline) {
    const [target] = await input.repository.claimRunnable({ limit: 1, workerToken });
    if (!target) break;
    claimed += 1;
    const abortController = new AbortController();
    let heartbeatInFlight = false;
    let leaseLostDuringRun = false;
    let runtimeExceededDuringRun = false;
    const runtimeTimer = setTimeout(
      () => {
        runtimeExceededDuringRun = true;
        abortController.abort();
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - now())),
    );
    runtimeTimer.unref();
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void input.repository
        .heartbeat({ periodRunId: target.periodRunId, workerToken })
        .then((extended) => {
          if (!extended) {
            leaseLostDuringRun = true;
            abortController.abort();
          }
        })
        .catch(() => {
          leaseLostDuringRun = true;
          abortController.abort();
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, input.heartbeatIntervalMs ?? 60_000);
    heartbeat.unref();

    try {
      const outcome = await input.runner.run(target, abortController.signal);
      if (leaseLostDuringRun) {
        leaseLost += 1;
        continue;
      }
      if (runtimeExceededDuringRun) {
        throw new Error(REPORT_SCHEDULE_RUNTIME_EXCEEDED_ERROR);
      }
      const updated =
        outcome.type === 'skipped'
          ? await input.repository.markSkipped({
              periodRunId: target.periodRunId,
              skipReason: outcome.skipReason ?? 'skipped',
              workerToken,
            })
          : await input.repository.markSucceeded({
              periodRunId: target.periodRunId,
              reportId: outcome.reportId ?? '',
              workerToken,
            });
      if (!updated) {
        leaseLost += 1;
        continue;
      }
      if (outcome.type === 'skipped') skipped += 1;
      else succeeded += 1;
    } catch (error) {
      if (leaseLostDuringRun) {
        console.error(
          JSON.stringify({
            event: 'report_schedule_lease_lost',
            periodRunId: target.periodRunId,
            projectId: target.projectId,
          }),
        );
        leaseLost += 1;
        continue;
      }
      const safeError = runtimeExceededDuringRun
        ? REPORT_SCHEDULE_RUNTIME_EXCEEDED_ERROR
        : safeReportScheduleError(error);
      console.error(
        JSON.stringify({
          error: safeError,
          event: 'report_schedule_execution_failed',
          periodRunId: target.periodRunId,
          projectId: target.projectId,
        }),
      );
      const updated = await input.repository.markFailed({
        error: safeError,
        periodRunId: target.periodRunId,
        workerToken,
      });
      if (updated) failed += 1;
      else leaseLost += 1;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(runtimeTimer);
    }
  }

  return { claimed, failed, leaseLost, materialized, skipped, succeeded };
}

export function safeReportScheduleError(error: unknown): string {
  if (error instanceof ReportScheduleGenerationError) {
    return `report schedule generation failed (${error.code})`;
  }
  return 'report schedule failed';
}

export class ReportScheduleGenerationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`report schedule generation failed (${code})`);
    this.name = 'ReportScheduleGenerationError';
    this.code = code;
  }
}
