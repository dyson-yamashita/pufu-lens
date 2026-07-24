import { createHash } from 'node:crypto';
import type {
  GitHubDocumentLifecycle,
  GitHubLifecycleReconcileDecision,
} from './github-lifecycle.js';
import {
  classifyGitHubLifecycleApiError,
  GITHUB_LIFECYCLE_ONLY_METADATA_KEY,
  githubLifecycleChanged,
  normalizeGitHubDocumentLifecycle,
  sanitizeGitHubLifecycleError,
} from './github-lifecycle.js';
import type { GitHubFetcher } from './github-source.js';
import { githubLogicalSourceId, githubSourceVersion } from './source-version-identity.js';

export type GitHubLifecycleTarget = {
  connectionId: string | null;
  dataSourceId: string;
  kind: 'issue' | 'pull_request';
  lifecycle: GitHubDocumentLifecycle | undefined;
  logicalSourceId: string;
  number: number;
  projectId: string;
  projectSlug: string;
  rawBody: string;
  rawDocumentId: string;
  rawMetadata: Record<string, unknown>;
  repository: string;
  sourceUri: string;
  sourceVersion: string;
  storageUri: string;
};

export type GitHubLifecycleReconcileItemResult = {
  decision: GitHubLifecycleReconcileDecision;
  error?: string;
  logicalSourceId: string;
  nextLifecycle?: GitHubDocumentLifecycle;
  rawDocumentId: string;
};

export type GitHubLifecycleReconcileBatchResult = {
  decisionCounts: Partial<Record<GitHubLifecycleReconcileDecision, number>>;
  decisions: GitHubLifecycleReconcileItemResult[];
  processed: number;
  remaining: number;
  resumeAfterLogicalSourceId?: string;
  stoppedEarly?: 'rate_limited';
};

export type GitHubLifecycleReconcileRepository = {
  countOpenGitHubLifecycleTargets(input: {
    dataSourceId?: string;
    projectId: string;
    resumeAfterLogicalSourceId?: string;
  }): Promise<number>;
  listOpenGitHubLifecycleTargets(input: {
    dataSourceId?: string;
    limit: number;
    projectId: string;
    resumeAfterLogicalSourceId?: string;
  }): Promise<GitHubLifecycleTarget[]>;
  queueLifecycleRefresh(input: {
    dataSourceId: string;
    logicalSourceId: string;
    nextLifecycle: GitHubDocumentLifecycle;
    projectId: string;
    projectSlug: string;
    rawBody: string;
    rawDocumentId: string;
    rawMetadata: Record<string, unknown>;
    repository: string;
    sourceUri: string;
  }): Promise<{ queued: boolean; rawDocumentId: string }>;
};

export type GitHubLifecycleReconcileCliBatchSummary = {
  decisionCounts: Partial<Record<GitHubLifecycleReconcileDecision, number>>;
  processed: number;
  remaining: number;
  /** Last logicalSourceId completed in this batch; unchanged when stopped by rate_limited. */
  resumeAfter?: string;
  stoppedEarly?: 'rate_limited';
};

/**
 * Builds CLI-safe batch summaries without per-item repository identifiers or raw errors.
 */
export function summarizeGitHubLifecycleBatchForCli(
  batch: GitHubLifecycleReconcileBatchResult,
): GitHubLifecycleReconcileCliBatchSummary {
  return {
    decisionCounts: batch.decisionCounts,
    processed: batch.processed,
    remaining: batch.remaining,
    resumeAfter: batch.resumeAfterLogicalSourceId,
    ...(batch.stoppedEarly ? { stoppedEarly: batch.stoppedEarly } : {}),
  };
}

/**
 * Reconciles a bounded batch of known GitHub items against the GitHub API.
 */
export async function reconcileGitHubLifecycleBatch(input: {
  dataSourceId?: string;
  dryRun?: boolean;
  fetcher: GitHubFetcher;
  limit: number;
  projectId: string;
  repository: GitHubLifecycleReconcileRepository;
  resolveToken: (target: GitHubLifecycleTarget) => Promise<string | undefined>;
  resumeAfterLogicalSourceId?: string;
}): Promise<GitHubLifecycleReconcileBatchResult> {
  const targets = await input.repository.listOpenGitHubLifecycleTargets({
    dataSourceId: input.dataSourceId,
    limit: input.limit,
    projectId: input.projectId,
    resumeAfterLogicalSourceId: input.resumeAfterLogicalSourceId,
  });
  const decisions: GitHubLifecycleReconcileItemResult[] = [];
  let stoppedEarly: 'rate_limited' | undefined;
  let completedThroughCursor = input.resumeAfterLogicalSourceId;

  for (const target of targets) {
    let token: string | undefined;
    try {
      token = await input.resolveToken(target);
    } catch (error) {
      decisions.push({
        decision: 'forbidden',
        error: sanitizeGitHubLifecycleError(error),
        logicalSourceId: target.logicalSourceId,
        rawDocumentId: target.rawDocumentId,
      });
      completedThroughCursor = target.logicalSourceId;
      continue;
    }
    if (!token) {
      decisions.push({
        decision: 'forbidden',
        error: 'GitHub OAuth connection is not configured for the data source.',
        logicalSourceId: target.logicalSourceId,
        rawDocumentId: target.rawDocumentId,
      });
      completedThroughCursor = target.logicalSourceId;
      continue;
    }
    const result = await reconcileGitHubLifecycleTarget({
      fetcher: input.fetcher,
      target,
      token,
    });
    if (
      !input.dryRun &&
      result.decision === 'status_changed' &&
      result.nextLifecycle &&
      githubLifecycleChanged(target.lifecycle, result.nextLifecycle)
    ) {
      await input.repository.queueLifecycleRefresh({
        dataSourceId: target.dataSourceId,
        logicalSourceId: target.logicalSourceId,
        nextLifecycle: result.nextLifecycle,
        projectId: target.projectId,
        projectSlug: target.projectSlug,
        rawBody: target.rawBody,
        rawDocumentId: target.rawDocumentId,
        rawMetadata: target.rawMetadata,
        repository: target.repository,
        sourceUri: target.sourceUri,
      });
    }
    decisions.push(result);
    if (result.decision === 'rate_limited') {
      stoppedEarly = 'rate_limited';
      break;
    }
    completedThroughCursor = target.logicalSourceId;
  }

  const resumeAfterLogicalSourceId = completedThroughCursor;
  const remaining = await input.repository.countOpenGitHubLifecycleTargets({
    dataSourceId: input.dataSourceId,
    projectId: input.projectId,
    resumeAfterLogicalSourceId,
  });

  return {
    decisionCounts: countGitHubLifecycleDecisions(decisions),
    decisions,
    processed: decisions.length,
    remaining,
    resumeAfterLogicalSourceId,
    stoppedEarly,
  };
}

/**
 * Fetches current lifecycle for one GitHub target and compares it with stored metadata.
 */
export async function reconcileGitHubLifecycleTarget(input: {
  fetcher: GitHubFetcher;
  target: GitHubLifecycleTarget;
  token: string;
}): Promise<GitHubLifecycleReconcileItemResult> {
  try {
    const nextLifecycle = await fetchGitHubLifecycle({
      fetcher: input.fetcher,
      kind: input.target.kind,
      number: input.target.number,
      repository: input.target.repository,
      token: input.token,
    });
    const decision: GitHubLifecycleReconcileDecision = githubLifecycleChanged(
      input.target.lifecycle,
      nextLifecycle,
    )
      ? 'status_changed'
      : 'unchanged';
    return {
      decision,
      logicalSourceId: input.target.logicalSourceId,
      nextLifecycle,
      rawDocumentId: input.target.rawDocumentId,
    };
  } catch (error) {
    return {
      decision: classifyGitHubLifecycleApiError(error),
      error: sanitizeGitHubLifecycleError(error),
      logicalSourceId: input.target.logicalSourceId,
      rawDocumentId: input.target.rawDocumentId,
    };
  }
}

/**
 * Builds a refreshed raw document body and source version for lifecycle-only updates.
 */
export function buildGitHubLifecycleRefreshRaw(input: {
  existingRaw: Record<string, unknown>;
  existingMetadata: Record<string, unknown>;
  nextLifecycle: GitHubDocumentLifecycle;
  repository: string;
}): {
  body: string;
  contentHash: string;
  logicalSourceId: string;
  metadata: Record<string, unknown>;
  sourceVersion: string;
} {
  const rawDocument = {
    ...input.existingRaw,
    lifecycle: input.nextLifecycle,
    updated_at: input.nextLifecycle.updatedAt,
  };
  const body = `${JSON.stringify(rawDocument, null, 2)}\n`;
  const logicalSourceId = githubLogicalSourceId({
    kind: input.nextLifecycle.kind,
    number: requiredNumber(input.existingRaw.number, 'number'),
    repository: input.repository,
  });
  const contentHash = createHash('sha256').update(body).digest('hex');
  return {
    body,
    contentHash,
    logicalSourceId,
    metadata: {
      ...input.existingMetadata,
      githubLifecycle: input.nextLifecycle,
      [GITHUB_LIFECYCLE_ONLY_METADATA_KEY]: true,
      updatedAt: input.nextLifecycle.updatedAt,
    },
    sourceVersion: githubSourceVersion(input.nextLifecycle.updatedAt, contentHash),
  };
}

async function fetchGitHubLifecycle(input: {
  fetcher: GitHubFetcher;
  kind: 'issue' | 'pull_request';
  number: number;
  repository: string;
  token: string;
}): Promise<GitHubDocumentLifecycle> {
  if (input.kind === 'pull_request') {
    const response = await input.fetcher({
      path: `/repos/${input.repository}/pulls/${input.number}`,
      token: input.token,
    });
    return normalizeGitHubDocumentLifecycle({
      issue: response as never,
      kind: 'pull_request',
      pullRequest: response as never,
    });
  }
  const response = await input.fetcher({
    path: `/repos/${input.repository}/issues/${input.number}`,
    token: input.token,
  });
  return normalizeGitHubDocumentLifecycle({
    issue: response as never,
    kind: 'issue',
  });
}

function countGitHubLifecycleDecisions(
  decisions: readonly GitHubLifecycleReconcileItemResult[],
): Partial<Record<GitHubLifecycleReconcileDecision, number>> {
  const counts: Partial<Record<GitHubLifecycleReconcileDecision, number>> = {};
  for (const decision of decisions) {
    counts[decision.decision] = (counts[decision.decision] ?? 0) + 1;
  }
  return counts;
}

function requiredNumber(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`GitHub raw field ${fieldName} must be an integer.`);
  }
  return Number(value);
}
