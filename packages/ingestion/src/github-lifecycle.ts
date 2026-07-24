import { createHash } from 'node:crypto';

/** Metadata key used across raw, parsed, and document records for GitHub lifecycle status. */
export const GITHUB_LIFECYCLE_METADATA_KEY = 'githubLifecycle' as const;

/** Marks ingestion rows whose body text is unchanged and only lifecycle metadata was refreshed. */
export const GITHUB_LIFECYCLE_ONLY_METADATA_KEY = 'lifecycleOnly' as const;

export type GitHubLifecycleState = 'closed' | 'open';

export type GitHubLifecycleKind = 'issue' | 'pull_request';

/**
 * Normalized GitHub document lifecycle status propagated through ingestion and retrieval.
 *
 * Issue #648 should treat `statusKnown=false` as "lifecycle not yet synchronized".
 */
export type GitHubDocumentLifecycle = {
  closedAt: string | null;
  draft: boolean | null;
  kind: GitHubLifecycleKind;
  merged: boolean | null;
  mergedAt: string | null;
  state: GitHubLifecycleState;
  stateReason: string | null;
  statusKnown: boolean;
  updatedAt: string;
};

export type GitHubIssueLifecycleInput = {
  closed_at?: string | null;
  pull_request?: unknown;
  state?: string | null;
  state_reason?: string | null;
  updated_at: string;
};

export type GitHubPullRequestLifecycleInput = {
  closed_at?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
  merged_at?: string | null;
  state?: string | null;
  updated_at: string;
};

export type GitHubLifecycleReconcileDecision =
  | 'forbidden'
  | 'fetch_failed'
  | 'not_found'
  | 'rate_limited'
  | 'status_changed'
  | 'unchanged';

/**
 * Returns the canonical built-in metadata object for parsed/document propagation.
 */
export function githubLifecycleMetadata(
  lifecycle: GitHubDocumentLifecycle,
): Record<string, GitHubDocumentLifecycle> {
  return { [GITHUB_LIFECYCLE_METADATA_KEY]: lifecycle };
}

/**
 * Normalizes GitHub Issue API fields into the shared lifecycle contract.
 */
export function normalizeGitHubIssueLifecycle(
  input: GitHubIssueLifecycleInput,
): GitHubDocumentLifecycle {
  return {
    closedAt: readNullableIsoTimestamp(input.closed_at),
    draft: null,
    kind: input.pull_request ? 'pull_request' : 'issue',
    merged: null,
    mergedAt: null,
    state: readLifecycleState(input.state),
    stateReason: readNullableString(input.state_reason),
    statusKnown: true,
    updatedAt: requiredIsoTimestamp(input.updated_at, 'updated_at'),
  };
}

/**
 * Normalizes GitHub Pull Request API fields into the shared lifecycle contract.
 */
export function normalizeGitHubPullRequestLifecycle(
  input: GitHubPullRequestLifecycleInput,
): GitHubDocumentLifecycle {
  const mergedAt = readNullableIsoTimestamp(input.merged_at);
  const merged = resolvePullRequestMerged({
    merged: readNullableBoolean(input.merged),
    mergedAt,
    state: input.state,
  });
  return {
    closedAt: readNullableIsoTimestamp(input.closed_at),
    draft: readNullableBoolean(input.draft),
    kind: 'pull_request',
    merged,
    mergedAt,
    state: readLifecycleState(input.state),
    stateReason: null,
    statusKnown: true,
    updatedAt: requiredIsoTimestamp(input.updated_at, 'updated_at'),
  };
}

/**
 * Picks the best available lifecycle normalization for a GitHub candidate.
 */
export function normalizeGitHubDocumentLifecycle(input: {
  issue: GitHubIssueLifecycleInput;
  kind: GitHubLifecycleKind;
  pullRequest?: GitHubPullRequestLifecycleInput;
}): GitHubDocumentLifecycle {
  if (input.kind === 'pull_request' && input.pullRequest) {
    return normalizeGitHubPullRequestLifecycle(input.pullRequest);
  }
  if (input.kind === 'pull_request') {
    const issueLifecycle = normalizeGitHubIssueLifecycle({
      ...input.issue,
      pull_request: {},
    });
    return {
      ...issueLifecycle,
      draft: readNullableBoolean((input.issue as Record<string, unknown>).draft),
      kind: 'pull_request',
      merged: resolvePullRequestMerged({
        merged: readNullableBoolean((input.issue as Record<string, unknown>).merged),
        mergedAt: readNullableIsoTimestamp((input.issue as Record<string, unknown>).merged_at),
        state: input.issue.state,
      }),
      mergedAt: readNullableIsoTimestamp((input.issue as Record<string, unknown>).merged_at),
      stateReason: null,
    };
  }
  return normalizeGitHubIssueLifecycle(input.issue);
}

/**
 * Parses lifecycle metadata from a raw/parsed/document metadata object.
 */
export function readGitHubDocumentLifecycle(
  metadata: Record<string, unknown> | undefined,
): GitHubDocumentLifecycle | undefined {
  if (!metadata) {
    return undefined;
  }
  const value = metadata[GITHUB_LIFECYCLE_METADATA_KEY];
  return parseGitHubDocumentLifecycle(value);
}

/**
 * Runtime-validates unknown lifecycle JSON.
 */
export function parseGitHubDocumentLifecycle(value: unknown): GitHubDocumentLifecycle | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid GitHub lifecycle metadata.');
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const state = record.state;
  if (kind !== 'issue' && kind !== 'pull_request') {
    throw new Error('Invalid GitHub lifecycle kind.');
  }
  if (state !== 'open' && state !== 'closed') {
    throw new Error('Invalid GitHub lifecycle state.');
  }
  return {
    closedAt: readNullableIsoTimestamp(record.closedAt),
    draft: readNullableBoolean(record.draft),
    kind,
    merged: readNullableBoolean(record.merged),
    mergedAt: readNullableIsoTimestamp(record.mergedAt),
    state,
    stateReason: readNullableString(record.stateReason),
    statusKnown: record.statusKnown === true,
    updatedAt: requiredIsoTimestamp(record.updatedAt, 'updatedAt'),
  };
}

/**
 * Returns true when lifecycle fields differ in a way that should trigger propagation.
 */
export function githubLifecycleChanged(
  previous: GitHubDocumentLifecycle | undefined,
  next: GitHubDocumentLifecycle,
): boolean {
  if (!previous) {
    return true;
  }
  return (
    previous.state !== next.state ||
    previous.closedAt !== next.closedAt ||
    previous.mergedAt !== next.mergedAt ||
    previous.merged !== next.merged ||
    previous.draft !== next.draft ||
    previous.stateReason !== next.stateReason ||
    previous.updatedAt !== next.updatedAt ||
    previous.statusKnown !== next.statusKnown
  );
}

/**
 * Hashes GitHub raw content fields that affect chunk text, excluding lifecycle metadata.
 */
export function githubRawContentSignature(input: {
  body: string;
  comments?: ReadonlyArray<{ body: string }>;
  title: string;
}): string {
  const payload = JSON.stringify({
    body: input.body,
    comments: (input.comments ?? []).map((comment) => comment.body),
    title: input.title,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Maps lifecycle metadata to AGE Document node properties.
 */
export function githubLifecycleGraphProperties(
  lifecycle: GitHubDocumentLifecycle,
): Record<string, string | boolean | null> {
  return {
    closedAt: lifecycle.closedAt,
    draft: lifecycle.draft,
    merged: lifecycle.merged,
    mergedAt: lifecycle.mergedAt,
    state: lifecycle.state,
    statusKnown: lifecycle.statusKnown,
  };
}

/**
 * Returns true when parsed/raw metadata represents a lifecycle-only GitHub refresh.
 */
export function isGitHubLifecycleOnlyRefresh(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[GITHUB_LIFECYCLE_ONLY_METADATA_KEY] === true;
}

/**
 * Classifies a GitHub API HTTP status into a reconciliation decision.
 */
export function classifyGitHubLifecycleFetchStatus(
  status: number,
): GitHubLifecycleReconcileDecision {
  if (status === 404) {
    return 'not_found';
  }
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  return 'fetch_failed';
}

/**
 * Classifies a GitHub API failure, including rate-limit responses sent as HTTP 403.
 */
export function classifyGitHubLifecycleApiError(error: unknown): GitHubLifecycleReconcileDecision {
  if (isGitHubApiRequestError(error)) {
    if (error.status === 429) {
      return 'rate_limited';
    }
    if (error.status === 403 && error.rateLimitRemaining === 0) {
      return 'rate_limited';
    }
    return classifyGitHubLifecycleFetchStatus(error.status);
  }
  const status = readGitHubLifecycleErrorStatus(error);
  return status ? classifyGitHubLifecycleFetchStatus(status) : 'fetch_failed';
}

/**
 * Redacts repository paths and secrets from lifecycle reconciliation errors.
 */
export function sanitizeGitHubLifecycleError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\/repos\/[^/\s]+\/[^/\s]+\//g, '/repos/<redacted>/')
    .replace(/(token|secret|api[_-]?key)=\S+/gi, '$1=<redacted>')
    .replace(/"Authorization"\s*:\s*"Bearer\s+[^"]*"/gi, '"Authorization":"Bearer <redacted>"')
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer <redacted>')
    .replace(/authorization=Bearer\s+\S+/gi, 'authorization=Bearer <redacted>')
    .replace(/Authorization:\s*(?!Bearer\b)\S+/gi, 'Authorization: <redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]+/g, '<redacted>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '<redacted>')
    .slice(0, 500);
}

function isGitHubApiRequestError(
  error: unknown,
): error is { rateLimitRemaining?: number; status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    (error as { name?: unknown }).name === 'GitHubApiRequestError'
  );
}

function readGitHubLifecycleErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const match = error.message.match(/status (\d{3})/);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

/**
 * Infers merged state when GitHub list responses omit the `merged` boolean.
 */
export function resolvePullRequestMerged(input: {
  merged: boolean | null;
  mergedAt: string | null;
  state?: string | null;
}): boolean | null {
  if (typeof input.merged === 'boolean') {
    return input.merged;
  }
  if (input.mergedAt !== null) {
    return true;
  }
  if (input.state === 'closed') {
    return false;
  }
  if (input.state === 'open') {
    return false;
  }
  return null;
}

function readLifecycleState(value: unknown): GitHubLifecycleState {
  return value === 'closed' ? 'closed' : 'open';
}

function readNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNullableIsoTimestamp(value: unknown): string | null {
  const normalized = readNullableString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error('Invalid GitHub lifecycle timestamp.');
  }
  return new Date(parsed).toISOString();
}

function requiredIsoTimestamp(value: unknown, fieldName: string): string {
  const normalized = readNullableIsoTimestamp(value);
  if (!normalized) {
    throw new Error(`GitHub lifecycle field ${fieldName} is required.`);
  }
  return normalized;
}
