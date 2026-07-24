import type { GitHubDocumentLifecycle } from './github-lifecycle.js';

/** Internal retrieval hint for Issue #648 status-aware graph coverage. */
export type GitHubLifecycleSelectionHint =
  | 'include_all'
  | 'open_primary_closed_background'
  | 'prefer_closed_or_merged'
  | 'prefer_open';

export type GitHubLifecycleRankedSource<T> = T & {
  lifecycleRank: number;
};

/**
 * Infers lifecycle selection behavior from question text and editing operation.
 */
export function inferGitHubLifecycleSelectionHint(input: {
  primaryOperation: string;
  question: string;
}): GitHubLifecycleSelectionHint {
  const text = input.question.toLowerCase();
  if (
    input.primaryOperation === 'next_actions' ||
    input.primaryOperation === 'risk_scan' ||
    /next action|次のアクション/.test(text)
  ) {
    return 'open_primary_closed_background';
  }
  if (/未解決|対応中|現在の課題|open issue|in progress|todo|残課題/.test(text)) {
    return 'prefer_open';
  }
  if (/完了|解決済|merged|クローズ済|closed|マージ/.test(text)) {
    return 'prefer_closed_or_merged';
  }
  if (
    /経緯|背景|なぜ|理由|history|timeline|変更/.test(text) ||
    input.primaryOperation === 'timeline'
  ) {
    return 'include_all';
  }
  return 'include_all';
}

/**
 * Ranks chat sources by lifecycle hint without removing closed graph-related documents.
 */
export function rankSourcesByGitHubLifecycle<
  T extends { githubLifecycle?: GitHubDocumentLifecycle },
>(sources: readonly T[], hint: GitHubLifecycleSelectionHint): GitHubLifecycleRankedSource<T>[] {
  return [...sources]
    .map((source, index) => ({
      ...source,
      lifecycleRank: lifecycleRank(source.githubLifecycle, hint, index),
    }))
    .sort((left, right) => left.lifecycleRank - right.lifecycleRank || 0);
}

/**
 * Returns true when a source should be filtered out for strict open-only queries.
 */
export function shouldFilterGitHubSourceByLifecycle(
  lifecycle: GitHubDocumentLifecycle | undefined,
  hint: GitHubLifecycleSelectionHint,
): boolean {
  if (hint !== 'prefer_open') {
    return false;
  }
  if (!lifecycle?.statusKnown) {
    return false;
  }
  return lifecycle.state !== 'open';
}

function lifecycleRank(
  lifecycle: GitHubDocumentLifecycle | undefined,
  hint: GitHubLifecycleSelectionHint,
  index: number,
): number {
  const base = index;
  if (!lifecycle?.statusKnown) {
    return 1000 + base;
  }
  switch (hint) {
    case 'prefer_open':
      return lifecycle.state === 'open' ? base : 500 + base;
    case 'prefer_closed_or_merged':
      if (lifecycle.state === 'closed') {
        return lifecycle.merged ? base : 10 + base;
      }
      return 400 + base;
    case 'open_primary_closed_background':
      return lifecycle.state === 'open' ? base : 200 + base;
    case 'include_all':
      return base;
  }
}
