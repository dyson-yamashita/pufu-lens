import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatchDueSourceSyncs,
  SOURCE_SYNC_RUNTIME_EXCEEDED_ERROR,
  SourceSyncCommandError,
  type SourceSyncScheduleRepository,
  type SourceSyncTarget,
  safeScheduleError,
} from './source-sync-dispatcher.ts';

const target: SourceSyncTarget = {
  dataSourceId: 'source-a',
  projectSlug: 'sample-a',
  scheduleId: 'schedule-a',
  sourceType: 'github',
};

function repository(
  targets: readonly SourceSyncTarget[] = [target],
): SourceSyncScheduleRepository & {
  failed: string[];
  succeeded: string[];
} {
  const queue = [...targets];
  return {
    failed: [],
    succeeded: [],
    async claimDue({ limit, workerToken }) {
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
    async markSucceeded({ scheduleId, workerToken }) {
      assert.equal(workerToken, 'worker-a');
      this.succeeded.push(scheduleId);
      return true;
    },
  };
}

test('due-none succeeds without invoking a provider runner', async () => {
  const repo = repository([]);
  let calls = 0;
  const result = await dispatchDueSourceSyncs({
    repository: repo,
    runner: {
      async run() {
        calls += 1;
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(result, { claimed: 0, failed: 0, leaseLost: 0, succeeded: 0 });
  assert.equal(calls, 0);
});

test('successful exact target is completed with the claiming worker token', async () => {
  const repo = repository();
  const seen: SourceSyncTarget[] = [];
  const result = await dispatchDueSourceSyncs({
    repository: repo,
    runner: {
      async run(value) {
        seen.push(value);
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(seen, [target]);
  assert.deepEqual(repo.succeeded, ['schedule-a']);
  assert.deepEqual(result, { claimed: 1, failed: 0, leaseLost: 0, succeeded: 1 });
});

test('default dispatch processes at most ten due sources', async () => {
  const targets = Array.from(
    { length: 12 },
    (_, index): SourceSyncTarget => ({
      ...target,
      dataSourceId: `source-${index}`,
      scheduleId: `schedule-${index}`,
    }),
  );
  const repo = repository(targets);
  let calls = 0;
  const result = await dispatchDueSourceSyncs({
    repository: repo,
    runner: {
      async run() {
        calls += 1;
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(calls, 10);
  assert.deepEqual(result, { claimed: 10, failed: 0, leaseLost: 0, succeeded: 10 });
});

test('runtime budget stops claiming another due source', async () => {
  let now = 1_000;
  const repo = repository([
    target,
    { ...target, dataSourceId: 'source-b', scheduleId: 'schedule-b' },
  ]);
  const result = await dispatchDueSourceSyncs({
    maxRuntimeMs: 45 * 60 * 1000,
    now: () => now,
    repository: repo,
    runner: {
      async run() {
        now += 45 * 60 * 1000;
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(repo.succeeded, ['schedule-a']);
  assert.deepEqual(result, { claimed: 1, failed: 0, leaseLost: 0, succeeded: 1 });
});

test('runtime budget aborts an active source and marks it failed for retry', async () => {
  const repo = repository();
  let signalAborted = false;
  const result = await dispatchDueSourceSyncs({
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
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(signalAborted, true);
  assert.deepEqual(repo.succeeded, []);
  assert.deepEqual(repo.failed, [SOURCE_SYNC_RUNTIME_EXCEEDED_ERROR]);
  assert.deepEqual(result, { claimed: 1, failed: 1, leaseLost: 0, succeeded: 0 });
});

test('large runtime budgets do not overflow the active source timer', async () => {
  const repo = repository();
  const result = await dispatchDueSourceSyncs({
    maxRuntimeMs: Number.MAX_SAFE_INTEGER,
    repository: repo,
    runner: {
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    },
    workerToken: 'worker-a',
  });
  assert.deepEqual(repo.succeeded, ['schedule-a']);
  assert.deepEqual(result, { claimed: 1, failed: 0, leaseLost: 0, succeeded: 1 });
});

test('failed commands persist only a bounded safe category', async () => {
  const repo = repository();
  const originalConsoleError = console.error;
  const logs: unknown[] = [];
  console.error = (...values: unknown[]) => {
    logs.push(values);
  };
  try {
    const result = await dispatchDueSourceSyncs({
      repository: repo,
      runner: {
        async run() {
          throw new SourceSyncCommandError('collect', 7);
        },
      },
      workerToken: 'worker-a',
    });
    assert.deepEqual(repo.failed, ['source sync collect failed (exit 7)']);
    assert.deepEqual(result, { claimed: 1, failed: 1, leaseLost: 0, succeeded: 0 });
    assert.equal(
      safeScheduleError(new Error('oauth_token=secret raw provider body')),
      'source sync failed',
    );
    assert.match(JSON.stringify(logs), /source sync collect failed \(exit 7\)/);
    assert.doesNotMatch(JSON.stringify(logs), /secret|provider body|oauth_token/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('stale worker completion is counted as lease lost', async () => {
  const repo = repository();
  repo.markSucceeded = async () => false;
  const result = await dispatchDueSourceSyncs({
    repository: repo,
    runner: { async run() {} },
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
  const result = await dispatchDueSourceSyncs({
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
      },
    },
    workerToken: 'worker-a',
  });
  assert.equal(completionCalls, 0);
  assert.equal(result.leaseLost, 1);
});

test('heartbeat errors abort the runner without persisting provider details', async () => {
  const repo = repository();
  repo.heartbeat = async () => {
    throw new Error('database response token=secret');
  };
  let failureCalls = 0;
  repo.markFailed = async () => {
    failureCalls += 1;
    return true;
  };
  const originalConsoleError = console.error;
  const logs: unknown[] = [];
  console.error = (...values: unknown[]) => {
    logs.push(values);
  };
  try {
    const result = await dispatchDueSourceSyncs({
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
                reject(new Error('raw provider body'));
              },
              { once: true },
            );
          });
        },
      },
      workerToken: 'worker-a',
    });
    assert.equal(failureCalls, 0);
    assert.deepEqual(result, { claimed: 1, failed: 0, leaseLost: 1, succeeded: 0 });
    assert.match(JSON.stringify(logs), /source_sync_lease_lost/);
    assert.doesNotMatch(JSON.stringify(logs), /secret|provider body|database response/);
  } finally {
    console.error = originalConsoleError;
  }
});
