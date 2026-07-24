import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubDocumentLifecycle } from './github-lifecycle.js';
import {
  inferGitHubLifecycleSelectionHint,
  rankSourcesByGitHubLifecycle,
  shouldFilterGitHubSourceByLifecycle,
} from './github-lifecycle-selection.js';

const openIssue: GitHubDocumentLifecycle = {
  closedAt: null,
  draft: null,
  kind: 'issue',
  merged: null,
  mergedAt: null,
  state: 'open',
  stateReason: null,
  statusKnown: true,
  updatedAt: '2026-05-08T10:00:00.000Z',
};

const closedIssue: GitHubDocumentLifecycle = {
  closedAt: '2026-05-08T12:00:00.000Z',
  draft: null,
  kind: 'issue',
  merged: null,
  mergedAt: null,
  state: 'closed',
  stateReason: 'completed',
  statusKnown: true,
  updatedAt: '2026-05-08T12:00:00.000Z',
};

test('inferGitHubLifecycleSelectionHint maps unresolved questions to strict open priority', () => {
  assert.equal(
    inferGitHubLifecycleSelectionHint({
      primaryOperation: 'general',
      question: '未解決のIssueは何がありますか',
    }),
    'prefer_open',
  );
  assert.equal(
    inferGitHubLifecycleSelectionHint({
      primaryOperation: 'timeline',
      question: '変更の経緯を教えて',
    }),
    'include_all',
  );
});

test('inferGitHubLifecycleSelectionHint maps next_actions to open-primary with closed background', () => {
  assert.equal(
    inferGitHubLifecycleSelectionHint({
      primaryOperation: 'next_actions',
      question: '次に何をすべきですか',
    }),
    'open_primary_closed_background',
  );
  assert.equal(
    inferGitHubLifecycleSelectionHint({
      primaryOperation: 'general',
      question: '次のアクションを整理してください',
    }),
    'open_primary_closed_background',
  );
  assert.equal(
    inferGitHubLifecycleSelectionHint({
      primaryOperation: 'risk_scan',
      question: 'リスクを確認したい',
    }),
    'open_primary_closed_background',
  );
});

test('rankSourcesByGitHubLifecycle keeps closed sources for open_primary_closed_background', () => {
  const ranked = rankSourcesByGitHubLifecycle(
    [
      { documentId: 'closed', githubLifecycle: closedIssue },
      { documentId: 'open', githubLifecycle: openIssue },
    ],
    'open_primary_closed_background',
  );
  assert.equal(ranked[0]?.documentId, 'open');
  assert.equal(ranked.length, 2);
  assert.equal(
    shouldFilterGitHubSourceByLifecycle(closedIssue, 'open_primary_closed_background'),
    false,
  );
});

test('rankSourcesByGitHubLifecycle prefers open sources without dropping closed ones', () => {
  const ranked = rankSourcesByGitHubLifecycle(
    [
      { documentId: 'closed', githubLifecycle: closedIssue },
      { documentId: 'open', githubLifecycle: openIssue },
    ],
    'prefer_open',
  );
  assert.equal(ranked[0]?.documentId, 'open');
  assert.equal(ranked.length, 2);
});

test('shouldFilterGitHubSourceByLifecycle only filters in strict open mode', () => {
  assert.equal(shouldFilterGitHubSourceByLifecycle(closedIssue, 'prefer_open'), true);
  assert.equal(shouldFilterGitHubSourceByLifecycle(closedIssue, 'include_all'), false);
});
