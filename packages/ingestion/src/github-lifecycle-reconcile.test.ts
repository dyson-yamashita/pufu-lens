import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeGitHubIssueLifecycle,
  normalizeGitHubPullRequestLifecycle,
  resolvePullRequestMerged,
} from './github-lifecycle.js';
import type { GitHubLifecycleTarget } from './github-lifecycle-reconcile.js';
import {
  buildGitHubLifecycleRefreshRaw,
  reconcileGitHubLifecycleBatch,
  reconcileGitHubLifecycleTarget,
  summarizeGitHubLifecycleBatchForCli,
} from './github-lifecycle-reconcile.js';
import { GitHubApiRequestError } from './github-source.js';

const openLifecycle = normalizeGitHubIssueLifecycle({
  state: 'open',
  updated_at: '2026-05-08T10:00:00.000Z',
});
const closedLifecycle = normalizeGitHubIssueLifecycle({
  closed_at: '2026-05-08T12:00:00.000Z',
  state: 'closed',
  state_reason: 'completed',
  updated_at: '2026-05-08T12:00:00.000Z',
});

function lifecycleTarget(overrides: Partial<GitHubLifecycleTarget> = {}): GitHubLifecycleTarget {
  return {
    connectionId: '00000000-0000-0000-0000-000000000101',
    dataSourceId: 'data-source-1',
    kind: 'issue',
    lifecycle: openLifecycle,
    logicalSourceId: 'example-org/repo/issues/101',
    number: 101,
    projectId: 'project-1',
    projectSlug: 'sample-a',
    rawBody: JSON.stringify({
      body: 'Issue body',
      kind: 'issue',
      number: 101,
      repository: 'example-org/repo',
      title: 'Title',
      updated_at: '2026-05-08T10:00:00.000Z',
    }),
    rawDocumentId: 'raw-1',
    rawMetadata: {
      dataSourceId: 'data-source-1',
      kind: 'issue',
      number: 101,
      repository: 'example-org/repo',
    },
    repository: 'example-org/repo',
    sourceUri: 'https://github.com/example-org/repo/issues/101',
    sourceVersion: 'v1',
    storageUri: 'sample-a/raw/github/issue.json',
    ...overrides,
  };
}

test('reconcileGitHubLifecycleTarget reports unchanged when lifecycle matches', async () => {
  const result = await reconcileGitHubLifecycleTarget({
    fetcher: async () => ({
      closed_at: null,
      state: 'open',
      updated_at: '2026-05-08T10:00:00.000Z',
    }),
    target: lifecycleTarget(),
    token: 'token',
  });
  assert.equal(result.decision, 'unchanged');
  assert.deepEqual(result.nextLifecycle?.state, 'open');
});

test('reconcileGitHubLifecycleTarget detects close transitions', async () => {
  const result = await reconcileGitHubLifecycleTarget({
    fetcher: async () => ({
      closed_at: '2026-05-08T12:00:00.000Z',
      state: 'closed',
      state_reason: 'completed',
      updated_at: '2026-05-08T12:00:00.000Z',
    }),
    target: lifecycleTarget(),
    token: 'token',
  });
  assert.equal(result.decision, 'status_changed');
  assert.equal(result.nextLifecycle?.state, 'closed');
});

test('reconcileGitHubLifecycleTarget detects reopen transitions', async () => {
  const result = await reconcileGitHubLifecycleTarget({
    fetcher: async () => ({
      closed_at: null,
      state: 'open',
      updated_at: '2026-05-08T13:00:00.000Z',
    }),
    target: lifecycleTarget({
      lifecycle: closedLifecycle,
    }),
    token: 'token',
  });
  assert.equal(result.decision, 'status_changed');
  assert.equal(result.nextLifecycle?.state, 'open');
});

test('reconcileGitHubLifecycleTarget maps API failures to decisions', async () => {
  const notFound = await reconcileGitHubLifecycleTarget({
    fetcher: async () => {
      throw new Error('GitHub request failed with status 404');
    },
    target: lifecycleTarget(),
    token: 'token',
  });
  const forbidden = await reconcileGitHubLifecycleTarget({
    fetcher: async () => {
      throw new GitHubApiRequestError({
        path: '/repos/example-org/repo/issues/101',
        rateLimitRemaining: 42,
        status: 403,
      });
    },
    target: lifecycleTarget(),
    token: 'token',
  });
  const rateLimited = await reconcileGitHubLifecycleTarget({
    fetcher: async () => {
      throw new GitHubApiRequestError({
        path: '/repos/example-org/repo/issues/101',
        status: 429,
      });
    },
    target: lifecycleTarget(),
    token: 'token',
  });
  const rateLimited403 = await reconcileGitHubLifecycleTarget({
    fetcher: async () => {
      throw new GitHubApiRequestError({
        path: '/repos/example-org/repo/issues/101',
        rateLimitRemaining: 0,
        status: 403,
      });
    },
    target: lifecycleTarget(),
    token: 'token',
  });
  assert.equal(notFound.decision, 'not_found');
  assert.equal(forbidden.decision, 'forbidden');
  assert.equal(rateLimited.decision, 'rate_limited');
  assert.equal(rateLimited403.decision, 'rate_limited');
  assert.doesNotMatch(notFound.error ?? '', /token/i);
  assert.doesNotMatch(notFound.error ?? '', /example-org/);
});

test('reconcileGitHubLifecycleBatch queues lifecycle refresh on status change', async () => {
  const queued: string[] = [];
  const result = await reconcileGitHubLifecycleBatch({
    fetcher: async () => ({
      closed_at: '2026-05-08T12:00:00.000Z',
      state: 'closed',
      state_reason: 'completed',
      updated_at: '2026-05-08T12:00:00.000Z',
    }),
    limit: 10,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets() {
        return 0;
      },
      async listOpenGitHubLifecycleTargets() {
        return [lifecycleTarget()];
      },
      async queueLifecycleRefresh(input) {
        queued.push(input.logicalSourceId);
        return { queued: true, rawDocumentId: 'raw-2' };
      },
    },
    resolveToken: async () => 'token',
  });
  assert.equal(result.processed, 1);
  assert.equal(result.decisions[0]?.decision, 'status_changed');
  assert.deepEqual(queued, ['example-org/repo/issues/101']);
});

test('reconcileGitHubLifecycleBatch dryRun suppresses queueLifecycleRefresh on status change', async () => {
  let queueCalls = 0;
  const result = await reconcileGitHubLifecycleBatch({
    dryRun: true,
    fetcher: async () => ({
      closed_at: '2026-05-08T12:00:00.000Z',
      state: 'closed',
      state_reason: 'completed',
      updated_at: '2026-05-08T12:00:00.000Z',
    }),
    limit: 10,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets() {
        return 0;
      },
      async listOpenGitHubLifecycleTargets() {
        return [lifecycleTarget()];
      },
      async queueLifecycleRefresh() {
        queueCalls += 1;
        return { queued: true, rawDocumentId: 'raw-2' };
      },
    },
    resolveToken: async () => 'token',
  });
  assert.equal(result.decisions[0]?.decision, 'status_changed');
  assert.equal(queueCalls, 0);
});

test('reconcileGitHubLifecycleBatch reports forbidden when token is unavailable', async () => {
  const result = await reconcileGitHubLifecycleBatch({
    fetcher: async () => {
      throw new Error('fetch should not run');
    },
    limit: 10,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets() {
        return 0;
      },
      async listOpenGitHubLifecycleTargets() {
        return [lifecycleTarget({ connectionId: null })];
      },
      async queueLifecycleRefresh() {
        throw new Error('queue should not run');
      },
    },
    resolveToken: async () => undefined,
  });
  assert.equal(result.decisions[0]?.decision, 'forbidden');
  assert.equal(result.processed, 1);
  assert.equal(result.resumeAfterLogicalSourceId, 'example-org/repo/issues/101');
});

test('reconcileGitHubLifecycleBatch converts resolveToken failures into per-target decisions', async () => {
  let fetchCalls = 0;
  const result = await reconcileGitHubLifecycleBatch({
    fetcher: async () => {
      fetchCalls += 1;
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 10,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets() {
        return 0;
      },
      async listOpenGitHubLifecycleTargets() {
        return [
          lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/101' }),
          lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/102', number: 102 }),
        ];
      },
      async queueLifecycleRefresh() {
        throw new Error('queue should not run');
      },
    },
    resolveToken: async (target) => {
      if (target.logicalSourceId.endsWith('/101')) {
        throw new Error(
          'connection resolution failed for /repos/secret-org/secret-repo/issues/101',
        );
      }
      return 'token';
    },
  });
  assert.equal(result.processed, 2);
  assert.equal(result.decisions[0]?.decision, 'forbidden');
  assert.equal(result.decisions[1]?.decision, 'unchanged');
  assert.equal(result.resumeAfterLogicalSourceId, 'example-org/repo/issues/102');
  assert.equal(fetchCalls, 1);
  assert.doesNotMatch(result.decisions[0]?.error ?? '', /secret-org/);
  assert.doesNotMatch(result.decisions[0]?.error ?? '', /secret-repo/);
});

test('reconcileGitHubLifecycleBatch detects open, close, and reopen in one run', async () => {
  const targets = [
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/101', number: 101 }),
    lifecycleTarget({
      kind: 'pull_request',
      lifecycle: openLifecycle,
      logicalSourceId: 'example-org/repo/pulls/102',
      number: 102,
    }),
    lifecycleTarget({
      lifecycle: closedLifecycle,
      logicalSourceId: 'example-org/repo/issues/103',
      number: 103,
    }),
  ];
  const result = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      if (path.endsWith('/issues/101')) {
        return {
          closed_at: '2026-05-08T12:00:00.000Z',
          state: 'closed',
          updated_at: '2026-05-08T12:00:00.000Z',
        };
      }
      if (path.endsWith('/pulls/102')) {
        return {
          merged_at: '2026-05-08T12:00:00.000Z',
          state: 'closed',
          updated_at: '2026-05-08T12:00:00.000Z',
        };
      }
      if (path.endsWith('/issues/103')) {
        return {
          closed_at: null,
          state: 'open',
          updated_at: '2026-05-08T13:00:00.000Z',
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    limit: 10,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets() {
        return 0;
      },
      async listOpenGitHubLifecycleTargets() {
        return targets;
      },
      async queueLifecycleRefresh() {
        return { queued: true, rawDocumentId: 'raw-next' };
      },
    },
    resolveToken: async () => 'token',
  });
  assert.deepEqual(
    result.decisions.map((decision) => decision.decision),
    ['status_changed', 'status_changed', 'status_changed'],
  );
});

test('buildGitHubLifecycleRefreshRaw preserves DB metadata fields', () => {
  const refreshed = buildGitHubLifecycleRefreshRaw({
    existingMetadata: {
      contentSignature: 'abc123',
      dataSourceId: 'data-source-1',
      kind: 'issue',
      number: 101,
      repository: 'example-org/repo',
    },
    existingRaw: {
      body: 'Issue body',
      kind: 'issue',
      number: 101,
      repository: 'example-org/repo',
      title: 'Title',
      updated_at: '2026-05-08T10:00:00.000Z',
    },
    nextLifecycle: closedLifecycle,
    repository: 'example-org/repo',
  });
  assert.equal(refreshed.metadata.lifecycleOnly, true);
  assert.equal(refreshed.metadata.repository, 'example-org/repo');
  assert.equal(refreshed.metadata.number, 101);
  assert.equal(refreshed.metadata.contentSignature, 'abc123');
});

test('normalizeGitHubPullRequestLifecycle infers merged from merged_at when merged is missing', () => {
  const merged = normalizeGitHubPullRequestLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    merged_at: '2026-05-08T11:59:00.000Z',
    state: 'closed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });
  const closedWithoutMerge = normalizeGitHubPullRequestLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    state: 'closed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });
  assert.equal(merged.merged, true);
  assert.equal(closedWithoutMerge.merged, false);
});

test('resolvePullRequestMerged treats open PRs as not merged', () => {
  assert.equal(resolvePullRequestMerged({ merged: null, mergedAt: null, state: 'open' }), false);
});

test('reconcileGitHubLifecycleBatch stops after rate_limited without calling later targets', async () => {
  let fetchCalls = 0;
  const result = await reconcileGitHubLifecycleBatch({
    fetcher: async () => {
      fetchCalls += 1;
      throw new GitHubApiRequestError({
        path: '/repos/example-org/repo/issues/101',
        status: 429,
      });
    },
    limit: 10,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets({ resumeAfterLogicalSourceId }) {
        return resumeAfterLogicalSourceId ? 1 : 2;
      },
      async listOpenGitHubLifecycleTargets() {
        return [
          lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/101' }),
          lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/102', number: 102 }),
        ];
      },
      async queueLifecycleRefresh() {
        throw new Error('queue should not run');
      },
    },
    resolveToken: async () => 'token',
  });
  assert.equal(result.processed, 1);
  assert.equal(result.remaining, 2);
  assert.equal(result.resumeAfterLogicalSourceId, undefined);
  assert.equal(result.stoppedEarly, 'rate_limited');
  assert.equal(fetchCalls, 1);
  assert.equal(result.decisionCounts.rate_limited, 1);
});

function createOrderedLifecycleRepository(targets: GitHubLifecycleTarget[]) {
  return {
    async countOpenGitHubLifecycleTargets(input: { resumeAfterLogicalSourceId?: string }) {
      const ordered = [...targets].sort((left, right) =>
        left.logicalSourceId.localeCompare(right.logicalSourceId),
      );
      const resumeAfter = input.resumeAfterLogicalSourceId;
      return resumeAfter
        ? ordered.filter((target) => target.logicalSourceId > resumeAfter).length
        : ordered.length;
    },
    async listOpenGitHubLifecycleTargets(input: {
      limit: number;
      resumeAfterLogicalSourceId?: string;
    }) {
      const ordered = [...targets].sort((left, right) =>
        left.logicalSourceId.localeCompare(right.logicalSourceId),
      );
      const resumeAfter = input.resumeAfterLogicalSourceId;
      const filtered = resumeAfter
        ? ordered.filter((target) => target.logicalSourceId > resumeAfter)
        : ordered;
      return filtered.slice(0, input.limit);
    },
    async queueLifecycleRefresh() {
      return { queued: false, rawDocumentId: 'raw-1' };
    },
  };
}

test('reconcileGitHubLifecycleBatch advances cursor through token resolution forbidden targets', async () => {
  const targets = [
    lifecycleTarget({
      connectionId: null,
      logicalSourceId: 'example-org/repo/issues/101',
      number: 101,
    }),
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/102', number: 102 }),
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/103', number: 103 }),
  ];
  const repository = createOrderedLifecycleRepository(targets);
  let fetchCalls = 0;
  const first = await reconcileGitHubLifecycleBatch({
    fetcher: async () => {
      fetchCalls += 1;
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 2,
    projectId: 'project-1',
    repository,
    resolveToken: async (target) => {
      if (target.logicalSourceId.endsWith('/101')) {
        return undefined;
      }
      if (target.logicalSourceId.endsWith('/102')) {
        throw new Error('connection resolution failed');
      }
      return 'token';
    },
  });
  assert.equal(first.processed, 2);
  assert.deepEqual(
    first.decisions.map((decision) => decision.decision),
    ['forbidden', 'forbidden'],
  );
  assert.equal(first.resumeAfterLogicalSourceId, 'example-org/repo/issues/102');
  assert.equal(first.remaining, 1);
  assert.equal(fetchCalls, 0);

  fetchCalls = 0;
  const second = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      fetchCalls += 1;
      assert.match(path, /\/issues\/103$/);
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 2,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
    resumeAfterLogicalSourceId: first.resumeAfterLogicalSourceId,
  });
  assert.equal(second.processed, 1);
  assert.equal(second.decisions[0]?.logicalSourceId, 'example-org/repo/issues/103');
  assert.equal(second.remaining, 0);
  assert.equal(fetchCalls, 1);
});

test('reconcileGitHubLifecycleBatch keeps completed-through cursor when rate_limited on second item (429)', async () => {
  const targets = [
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/101', number: 101 }),
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/102', number: 102 }),
  ];
  const repository = createOrderedLifecycleRepository(targets);
  let fetchCalls = 0;
  const first = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      fetchCalls += 1;
      if (path.endsWith('/issues/102')) {
        throw new GitHubApiRequestError({
          path,
          status: 429,
        });
      }
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 10,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
  });
  assert.equal(first.processed, 2);
  assert.equal(first.resumeAfterLogicalSourceId, 'example-org/repo/issues/101');
  assert.equal(first.remaining, 1);
  assert.equal(first.stoppedEarly, 'rate_limited');
  assert.equal(fetchCalls, 2);

  fetchCalls = 0;
  const second = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      fetchCalls += 1;
      assert.match(path, /\/issues\/102$/);
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 10,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
    resumeAfterLogicalSourceId: first.resumeAfterLogicalSourceId,
  });
  assert.equal(second.processed, 1);
  assert.equal(second.decisions[0]?.logicalSourceId, 'example-org/repo/issues/102');
  assert.equal(fetchCalls, 1);
});

test('reconcileGitHubLifecycleBatch keeps completed-through cursor when rate_limited on second item (403)', async () => {
  const targets = [
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/101', number: 101 }),
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/102', number: 102 }),
  ];
  const repository = createOrderedLifecycleRepository(targets);
  const first = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      if (path.endsWith('/issues/102')) {
        throw new GitHubApiRequestError({
          path,
          rateLimitRemaining: 0,
          status: 403,
        });
      }
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 10,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
  });
  assert.equal(first.resumeAfterLogicalSourceId, 'example-org/repo/issues/101');
  assert.equal(first.remaining, 1);

  const second = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      assert.match(path, /\/issues\/102$/);
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 10,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
    resumeAfterLogicalSourceId: first.resumeAfterLogicalSourceId,
  });
  assert.equal(second.decisions[0]?.logicalSourceId, 'example-org/repo/issues/102');
});

test('reconcileGitHubLifecycleBatch retries the rate-limited first item on the next resume (429)', async () => {
  const targets = [
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/101', number: 101 }),
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/102', number: 102 }),
  ];
  const repository = createOrderedLifecycleRepository(targets);
  const first = await reconcileGitHubLifecycleBatch({
    fetcher: async () => {
      throw new GitHubApiRequestError({
        path: '/repos/example-org/repo/issues/101',
        status: 429,
      });
    },
    limit: 10,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
  });
  assert.equal(first.resumeAfterLogicalSourceId, undefined);
  assert.equal(first.remaining, 2);

  const second = await reconcileGitHubLifecycleBatch({
    fetcher: async ({ path }) => {
      assert.match(path, /\/issues\/101$/);
      return {
        closed_at: null,
        state: 'open',
        updated_at: '2026-05-08T10:00:00.000Z',
      };
    },
    limit: 10,
    projectId: 'project-1',
    repository,
    resolveToken: async () => 'token',
    resumeAfterLogicalSourceId: first.resumeAfterLogicalSourceId,
  });
  assert.equal(second.decisions[0]?.logicalSourceId, 'example-org/repo/issues/101');
});

test('reconcileGitHubLifecycleBatch resume cursor advances in logicalSourceId order', async () => {
  const targets = [
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/a', number: 1 }),
    lifecycleTarget({ logicalSourceId: 'example-org/repo/issues/z', number: 2 }),
  ];
  const first = await reconcileGitHubLifecycleBatch({
    fetcher: async () => ({
      closed_at: null,
      state: 'open',
      updated_at: '2026-05-08T10:00:00.000Z',
    }),
    limit: 1,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets({ resumeAfterLogicalSourceId }) {
        return resumeAfterLogicalSourceId ? 0 : 1;
      },
      async listOpenGitHubLifecycleTargets(input) {
        const ordered = [...targets].sort((left, right) =>
          left.logicalSourceId.localeCompare(right.logicalSourceId),
        );
        const resumeAfter = input.resumeAfterLogicalSourceId;
        const filtered = resumeAfter
          ? ordered.filter((target) => target.logicalSourceId > resumeAfter)
          : ordered;
        return filtered.slice(0, input.limit);
      },
      async queueLifecycleRefresh() {
        return { queued: false, rawDocumentId: 'raw-1' };
      },
    },
    resolveToken: async () => 'token',
  });
  const second = await reconcileGitHubLifecycleBatch({
    fetcher: async () => ({
      closed_at: null,
      state: 'open',
      updated_at: '2026-05-08T10:00:00.000Z',
    }),
    limit: 1,
    projectId: 'project-1',
    repository: {
      async countOpenGitHubLifecycleTargets() {
        return 0;
      },
      async listOpenGitHubLifecycleTargets(input) {
        const ordered = [...targets].sort((left, right) =>
          left.logicalSourceId.localeCompare(right.logicalSourceId),
        );
        const resumeAfter = input.resumeAfterLogicalSourceId;
        const filtered = resumeAfter
          ? ordered.filter((target) => target.logicalSourceId > resumeAfter)
          : ordered;
        return filtered.slice(0, input.limit);
      },
      async queueLifecycleRefresh() {
        return { queued: false, rawDocumentId: 'raw-1' };
      },
    },
    resolveToken: async () => 'token',
    resumeAfterLogicalSourceId: first.resumeAfterLogicalSourceId,
  });
  assert.equal(first.processed, 1);
  assert.equal(first.decisions[0]?.logicalSourceId, 'example-org/repo/issues/a');
  assert.equal(second.processed, 1);
  assert.equal(second.decisions[0]?.logicalSourceId, 'example-org/repo/issues/z');
});

test('summarizeGitHubLifecycleBatchForCli omits per-item repository identifiers', () => {
  const summary = summarizeGitHubLifecycleBatchForCli({
    decisionCounts: { unchanged: 1, rate_limited: 1 },
    decisions: [
      {
        decision: 'unchanged',
        error: 'failed for /repos/private-org/private-repo/issues/1',
        logicalSourceId: 'private-org/private-repo/issues/1',
        rawDocumentId: 'raw-1',
      },
    ],
    processed: 1,
    remaining: 2,
    resumeAfterLogicalSourceId: 'private-org/private-repo/issues/1',
    stoppedEarly: 'rate_limited',
  });
  assert.deepEqual(summary.decisionCounts, { unchanged: 1, rate_limited: 1 });
  assert.equal(summary.resumeAfter, 'private-org/private-repo/issues/1');
  assert.equal(summary.stoppedEarly, 'rate_limited');
  assert.equal('decisions' in summary, false);
  assert.equal('error' in summary, false);
});
