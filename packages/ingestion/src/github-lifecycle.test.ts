import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGitHubLifecycleApiError,
  classifyGitHubLifecycleFetchStatus,
  githubLifecycleChanged,
  githubLifecycleGraphProperties,
  githubLifecycleMetadata,
  githubRawContentSignature,
  normalizeGitHubDocumentLifecycle,
  normalizeGitHubIssueLifecycle,
  normalizeGitHubPullRequestLifecycle,
  parseGitHubDocumentLifecycle,
  sanitizeGitHubLifecycleError,
} from './github-lifecycle.js';
import { GitHubApiRequestError } from './github-source.js';

test('normalizeGitHubIssueLifecycle captures issue fields', () => {
  const lifecycle = normalizeGitHubIssueLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    state: 'closed',
    state_reason: 'completed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });
  assert.deepEqual(lifecycle, {
    closedAt: '2026-05-08T12:00:00.000Z',
    draft: null,
    kind: 'issue',
    merged: null,
    mergedAt: null,
    state: 'closed',
    stateReason: 'completed',
    statusKnown: true,
    updatedAt: '2026-05-08T12:00:00.000Z',
  });
});

test('normalizeGitHubPullRequestLifecycle distinguishes merged and draft PRs', () => {
  const merged = normalizeGitHubPullRequestLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    draft: false,
    merged: true,
    merged_at: '2026-05-08T11:59:00.000Z',
    state: 'closed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });
  const closedWithoutMerge = normalizeGitHubPullRequestLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    draft: false,
    merged: false,
    merged_at: null,
    state: 'closed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });
  assert.equal(merged.merged, true);
  assert.equal(closedWithoutMerge.merged, false);
  assert.equal(closedWithoutMerge.mergedAt, null);
});

test('normalizeGitHubDocumentLifecycle uses pull request fields when available', () => {
  const lifecycle = normalizeGitHubDocumentLifecycle({
    issue: {
      state: 'closed',
      updated_at: '2026-05-08T12:00:00.000Z',
    },
    kind: 'pull_request',
    pullRequest: {
      draft: true,
      merged: false,
      state: 'open',
      updated_at: '2026-05-08T12:00:00.000Z',
    },
  });
  assert.equal(lifecycle.draft, true);
  assert.equal(lifecycle.state, 'open');
});

test('githubLifecycleChanged detects reopen and merge transitions', () => {
  const open = normalizeGitHubIssueLifecycle({
    state: 'open',
    updated_at: '2026-05-08T10:00:00.000Z',
  });
  const closed = normalizeGitHubIssueLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    state: 'closed',
    state_reason: 'completed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });
  assert.equal(githubLifecycleChanged(open, open), false);
  assert.equal(githubLifecycleChanged(open, closed), true);
});

test('githubRawContentSignature ignores lifecycle-only changes', () => {
  const first = githubRawContentSignature({
    body: 'Issue body',
    comments: [{ body: 'comment' }],
    title: 'Title',
  });
  const second = githubRawContentSignature({
    body: 'Issue body',
    comments: [{ body: 'comment' }],
    title: 'Title',
  });
  assert.equal(first, second);
});

test('parseGitHubDocumentLifecycle round-trips metadata', () => {
  const lifecycle = githubLifecycleMetadata(
    normalizeGitHubPullRequestLifecycle({
      merged: true,
      merged_at: '2026-05-08T11:59:00.000Z',
      state: 'closed',
      updated_at: '2026-05-08T12:00:00.000Z',
    }),
  )['githubLifecycle' as const];
  assert.ok(lifecycle);
  assert.deepEqual(parseGitHubDocumentLifecycle(lifecycle), lifecycle);
  assert.deepEqual(githubLifecycleGraphProperties(lifecycle).state, 'closed');
});

test('classifyGitHubLifecycleFetchStatus maps API failures', () => {
  assert.equal(classifyGitHubLifecycleFetchStatus(404), 'not_found');
  assert.equal(classifyGitHubLifecycleFetchStatus(403), 'forbidden');
  assert.equal(classifyGitHubLifecycleFetchStatus(429), 'rate_limited');
  assert.equal(classifyGitHubLifecycleFetchStatus(500), 'fetch_failed');
});

test('classifyGitHubLifecycleApiError treats rate-limited 403 responses as rate_limited', () => {
  assert.equal(
    classifyGitHubLifecycleApiError(
      new GitHubApiRequestError({
        path: '/repos/private-org/private-repo/issues/1',
        rateLimitRemaining: 0,
        status: 403,
      }),
    ),
    'rate_limited',
  );
  assert.equal(
    classifyGitHubLifecycleApiError(
      new GitHubApiRequestError({
        path: '/repos/private-org/private-repo/issues/1',
        status: 429,
      }),
    ),
    'rate_limited',
  );
  assert.equal(
    classifyGitHubLifecycleApiError(
      new GitHubApiRequestError({
        path: '/repos/private-org/private-repo/issues/1',
        rateLimitRemaining: 42,
        status: 403,
      }),
    ),
    'forbidden',
  );
});

test('sanitizeGitHubLifecycleError redacts repository paths and secrets', () => {
  const sanitized = sanitizeGitHubLifecycleError(
    new Error(
      'GitHub API request failed with status 403: /repos/private-org/private-repo/issues/101 token=abc123',
    ),
  );
  assert.match(sanitized, /\/repos\/<redacted>\//);
  assert.doesNotMatch(sanitized, /private-org/);
  assert.doesNotMatch(sanitized, /token=abc123/);
});
