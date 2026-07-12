import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DEFAULT_DISPATCH_LIMIT = 10;
const DEFAULT_MAX_RUNTIME_MS = 45 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const SOURCE_SYNC_RUNTIME_EXCEEDED_ERROR = 'source sync dispatcher runtime exceeded';

export interface SourceSyncTarget {
  readonly dataSourceId: string;
  readonly projectSlug: string;
  readonly scheduleId: string;
  readonly sourceType: 'drive' | 'github' | 'gmail';
}

export interface SourceSyncScheduleRepository {
  claimDue(input: {
    readonly limit: number;
    readonly workerToken: string;
  }): Promise<readonly SourceSyncTarget[]>;
  heartbeat(input: { readonly scheduleId: string; readonly workerToken: string }): Promise<boolean>;
  markFailed(input: {
    readonly error: string;
    readonly scheduleId: string;
    readonly workerToken: string;
  }): Promise<boolean>;
  markSucceeded(input: {
    readonly scheduleId: string;
    readonly workerToken: string;
  }): Promise<boolean>;
}

export interface SourceSyncRunner {
  run(target: SourceSyncTarget, signal: AbortSignal): Promise<void>;
}

export interface SourceSyncDispatchResult {
  readonly claimed: number;
  readonly failed: number;
  readonly leaseLost: number;
  readonly succeeded: number;
}

export async function dispatchDueSourceSyncs(input: {
  readonly heartbeatIntervalMs?: number;
  readonly limit?: number;
  readonly maxRuntimeMs?: number;
  readonly now?: () => number;
  readonly repository: SourceSyncScheduleRepository;
  readonly runner: SourceSyncRunner;
  readonly workerToken?: string;
}): Promise<SourceSyncDispatchResult> {
  const workerToken = input.workerToken ?? randomUUID();
  const limit = input.limit ?? DEFAULT_DISPATCH_LIMIT;
  const maxRuntimeMs = input.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
  const now = input.now ?? (() => performance.now());
  const deadline = now() + maxRuntimeMs;
  let claimed = 0;
  let failed = 0;
  let leaseLost = 0;
  let succeeded = 0;

  while (claimed < limit && now() < deadline) {
    // Claim immediately before execution so later serial targets do not lose
    // their lease while an earlier source is still running.
    const [target] = await input.repository.claimDue({ limit: 1, workerToken });
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
        .heartbeat({ scheduleId: target.scheduleId, workerToken })
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
      await input.runner.run(target, abortController.signal);
      if (leaseLostDuringRun) {
        leaseLost += 1;
        continue;
      }
      if (runtimeExceededDuringRun) {
        throw new Error(SOURCE_SYNC_RUNTIME_EXCEEDED_ERROR);
      }
      const updated = await input.repository.markSucceeded({
        scheduleId: target.scheduleId,
        workerToken,
      });
      if (updated) succeeded += 1;
      else leaseLost += 1;
    } catch (error) {
      if (leaseLostDuringRun) {
        console.error(
          JSON.stringify({
            event: 'source_sync_lease_lost',
            scheduleId: target.scheduleId,
            sourceType: target.sourceType,
          }),
        );
        leaseLost += 1;
        continue;
      }
      const safeError = runtimeExceededDuringRun
        ? SOURCE_SYNC_RUNTIME_EXCEEDED_ERROR
        : safeScheduleError(error);
      console.error(
        JSON.stringify({
          error: safeError,
          event: 'source_sync_execution_failed',
          scheduleId: target.scheduleId,
          sourceType: target.sourceType,
        }),
      );
      const updated = await input.repository.markFailed({
        error: safeError,
        scheduleId: target.scheduleId,
        workerToken,
      });
      if (updated) failed += 1;
      else leaseLost += 1;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(runtimeTimer);
    }
  }

  return { claimed, failed, leaseLost, succeeded };
}

export function safeScheduleError(error: unknown): string {
  if (error instanceof SourceSyncCommandError) {
    return `source sync ${error.step} failed (exit ${error.exitCode ?? 'unknown'})`;
  }
  return 'source sync failed';
}

export class SourceSyncCommandError extends Error {
  readonly step: 'collect' | 'ingest';
  readonly exitCode: number | null;

  constructor(step: 'collect' | 'ingest', exitCode: number | null) {
    super(`source sync ${step} failed`);
    this.name = 'SourceSyncCommandError';
    this.step = step;
    this.exitCode = exitCode;
  }
}
