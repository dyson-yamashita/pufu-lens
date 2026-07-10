import { randomUUID } from 'node:crypto';

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
  readonly repository: SourceSyncScheduleRepository;
  readonly runner: SourceSyncRunner;
  readonly workerToken?: string;
}): Promise<SourceSyncDispatchResult> {
  const workerToken = input.workerToken ?? randomUUID();
  // Cloud Scheduler starts another execution every five minutes. One source per
  // execution keeps the Cloud Run task within the bounded lease/runtime window.
  const limit = input.limit ?? 1;
  let claimed = 0;
  let failed = 0;
  let leaseLost = 0;
  let succeeded = 0;

  while (claimed < limit) {
    // Claim immediately before execution so later serial targets do not lose
    // their lease while an earlier source is still running.
    const [target] = await input.repository.claimDue({ limit: 1, workerToken });
    if (!target) break;
    claimed += 1;
    const abortController = new AbortController();
    let heartbeatInFlight = false;
    let leaseLostDuringRun = false;
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
      clearInterval(heartbeat);
      if (leaseLostDuringRun) {
        leaseLost += 1;
        continue;
      }
      const updated = await input.repository.markSucceeded({
        scheduleId: target.scheduleId,
        workerToken,
      });
      if (updated) succeeded += 1;
      else leaseLost += 1;
    } catch (error) {
      clearInterval(heartbeat);
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
      const safeError = safeScheduleError(error);
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
