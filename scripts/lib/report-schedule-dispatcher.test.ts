import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchReportSchedules,
  REPORT_SCHEDULE_RUNTIME_EXCEEDED_ERROR,
  type ReportScheduleDispatcherRepository,
  ReportScheduleGenerationError,
  type ReportScheduleRunOutcome,
  type ReportScheduleRunTarget,
  safeReportScheduleError,
} from './report-schedule-dispatcher.ts';

const target: ReportScheduleRunTarget = {
  frequency: 'weekly',
  periodEnd: '2026-07-12',
  periodRunId: 'period-a',
  periodStart: '2026-07-06',
  projectId: 'project-a',
  projectSlug: 'sample-a',
  runKind: 'scheduled',
  scheduleId: 'schedule-a',
};

function repository(
  targets: readonly ReportScheduleRunTarget[] = [target],
): ReportScheduleDispatcherRepository & {
  failed: string[];
  materialized: number;
  skipped: string[];
  succeeded: string[];
} {
  const queue = [...targets];
  return {
    failed: [],
    materialized: 0,
    skipped: [],
    succeeded: [],
    async materializeDue({ limit }) {
      const count = Math.min(limit, 2);
      this.materialized += count;
      return count;
    },
    async claimRunnable({ limit, workerToken }) {
      assert.equal(workerToken, 'worker-a');
      return queue.splice(0, limit);
    },
    async heartbeat() {
      return true;
    },
    async markFailed({ error, workerToken }) {
      assert.equal(workerToken, 'worker-a');
      this.failed.push(error);
      return true;
    },
    async markSkipped({ periodRunId, skipReason, workerToken }) {
      assert.equal(workerToken, 'worker-a');
      assert.ok(skipReason.length > 0);
      this.skipped.push(`${periodRunId}:${skipReason}`);
      return true;
    },
    async markSucceeded({ periodRunId, reportId, workerToken }) {
      assert.equal(workerToken, 'worker-a');
      assert.ok(reportId.length > 0);
      this.succeeded.push(`${periodRunId}:${reportId}`);
      return true;
    },
  };
}

test('ReportScheduleRunOutcome requires branch-specific properties', () => {
  const reportOutcome = { reportId: 'report-a', type: 'report' } satisfies ReportScheduleRunOutcome;
  const skippedOutcome = {
    skipReason: 'no_documents',
    type: 'skipped',
  } satisfies ReportScheduleRunOutcome;
  assert.equal(reportOutcome.reportId, 'report-a');
  assert.equal(skippedOutcome.skipReason, 'no_documents');
});

test('materialize limit bounds catch-up work per dispatcher run', async () => {
  let materializeCalls = 0;
  const repo = repository([]);
  repo.materializeDue = async ({ limit }) => {
    materializeCalls += 1;
    return limit;
  };
  const result = await dispatchReportSchedules({
    materializeLimit: 3,
    repository: repo,
    runner: {
      async run() {
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(materializeCalls, 1);
  assert.equal(result.materialized, 3);
});

test('due-none succeeds without invoking a report runner', async () => {
  const repo = repository([]);
  let calls = 0;
  const result = await dispatchReportSchedules({
    repository: repo,
    runner: {
      async run() {
        calls += 1;
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(repo.materialized, 2);
  assert.deepEqual(result, {
    claimed: 0,
    failed: 0,
    leaseLost: 0,
    materialized: 2,
    skipped: 0,
    succeeded: 0,
  });
  assert.equal(calls, 0);
});

test('successful period run is completed with the claiming worker token', async () => {
  const repo = repository();
  const seen: ReportScheduleRunTarget[] = [];
  const result = await dispatchReportSchedules({
    repository: repo,
    runner: {
      async run(value) {
        seen.push(value);
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(seen, [target]);
  assert.deepEqual(repo.succeeded, ['period-a:report-a']);
  assert.deepEqual(result, {
    claimed: 1,
    failed: 0,
    leaseLost: 0,
    materialized: 2,
    skipped: 0,
    succeeded: 1,
  });
});

test('no candidate documents are marked skipped without provider invocation', async () => {
  const repo = repository();
  const result = await dispatchReportSchedules({
    repository: repo,
    runner: {
      async run() {
        return { skipReason: 'no_documents', type: 'skipped' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(repo.skipped, ['period-a:no_documents']);
  assert.deepEqual(result, {
    claimed: 1,
    failed: 0,
    leaseLost: 0,
    materialized: 2,
    skipped: 1,
    succeeded: 0,
  });
});

test('default dispatch processes at most ten runnable period runs', async () => {
  const targets = Array.from(
    { length: 12 },
    (_, index): ReportScheduleRunTarget => ({
      ...target,
      periodRunId: `period-${index}`,
    }),
  );
  const repo = repository(targets);
  let calls = 0;
  const result = await dispatchReportSchedules({
    repository: repo,
    runner: {
      async run() {
        calls += 1;
        return { reportId: `report-${calls}`, type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(calls, 10);
  assert.equal(result.claimed, 10);
  assert.equal(result.succeeded, 10);
});

test('runtime budget stops claiming another runnable period run', async () => {
  let now = 1_000;
  const repo = repository([target, { ...target, periodRunId: 'period-b' }]);
  const result = await dispatchReportSchedules({
    maxRuntimeMs: 45 * 60 * 1000,
    now: () => now,
    repository: repo,
    runner: {
      async run() {
        now += 45 * 60 * 1000;
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(repo.succeeded, ['period-a:report-a']);
  assert.deepEqual(result, {
    claimed: 1,
    failed: 0,
    leaseLost: 0,
    materialized: 2,
    skipped: 0,
    succeeded: 1,
  });
});

test('failed generation persists only a bounded safe category', async () => {
  const repo = repository();
  const originalConsoleError = console.error;
  const logs: unknown[] = [];
  console.error = (...values: unknown[]) => {
    logs.push(values);
  };
  try {
    const result = await dispatchReportSchedules({
      repository: repo,
      runner: {
        async run() {
          throw new ReportScheduleGenerationError('provider_unavailable');
        },
      },
      workerToken: 'worker-a',
    });
    assert.deepEqual(repo.failed, ['report schedule generation failed (provider_unavailable)']);
    assert.deepEqual(result, {
      claimed: 1,
      failed: 1,
      leaseLost: 0,
      materialized: 2,
      skipped: 0,
      succeeded: 0,
    });
    assert.equal(
      safeReportScheduleError(new Error('oauth_token=secret raw provider body')),
      'report schedule failed',
    );
    assert.match(
      JSON.stringify(logs),
      /report schedule generation failed \(provider_unavailable\)/,
    );
    assert.doesNotMatch(JSON.stringify(logs), /secret|provider body|oauth_token/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('stale worker completion is counted as lease lost', async () => {
  const repo = repository();
  repo.markSucceeded = async () => false;
  const result = await dispatchReportSchedules({
    repository: repo,
    runner: {
      async run() {
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(result.leaseLost, 1);
  assert.equal(result.succeeded, 0);
});

test('heartbeat lease loss aborts the runner and prevents completion', async () => {
  const repo = repository();
  repo.heartbeat = async () => false;
  let completionCalls = 0;
  repo.markSucceeded = async () => {
    completionCalls += 1;
    return true;
  };
  const result = await dispatchReportSchedules({
    heartbeatIntervalMs: 1,
    repository: repo,
    runner: {
      async run(_target, signal) {
        await new Promise<void>((_resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('heartbeat did not abort')), 2_000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(completionCalls, 0);
  assert.equal(result.leaseLost, 1);
});

test('runtime budget aborts an active period run and marks it failed for retry', async () => {
  const repo = repository();
  let signalAborted = false;
  const result = await dispatchReportSchedules({
    maxRuntimeMs: 5,
    repository: repo,
    runner: {
      async run(_target, signal) {
        await new Promise<void>((_resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('runtime did not abort')), 100);
          signal.addEventListener(
            'abort',
            () => {
              signalAborted = true;
              clearTimeout(timeout);
              reject(new Error('aborted at runtime limit'));
            },
            { once: true },
          );
        });
        return { reportId: 'report-a', type: 'report' };
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(signalAborted, true);
  assert.deepEqual(repo.succeeded, []);
  assert.deepEqual(repo.failed, [REPORT_SCHEDULE_RUNTIME_EXCEEDED_ERROR]);
  assert.deepEqual(result, {
    claimed: 1,
    failed: 1,
    leaseLost: 0,
    materialized: 2,
    skipped: 0,
    succeeded: 0,
  });
});
