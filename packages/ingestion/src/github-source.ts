import { createHash } from 'node:crypto';
import type {
  CollectDecision,
  CollectionObjectStorage,
  CollectionRepository,
  DataSourceRecord,
  RawDocumentInput,
} from './collection-pipeline.js';
import {
  completedSyncCursor,
  incrementalScanSince,
  normalizeSourceId,
} from './collection-pipeline.js';
import type { GitHubDocumentLifecycle } from './github-lifecycle.js';
import {
  githubLifecycleMetadata,
  githubRawContentSignature,
  normalizeGitHubDocumentLifecycle,
} from './github-lifecycle.js';
import { fetchWithRetry } from './http-retry.js';
import { githubLogicalSourceId, githubSourceVersion } from './source-version-identity.js';

export interface GitHubIssueResponse {
  body?: string | null;
  closed_at?: string | null;
  comments_url?: string;
  created_at: string;
  diff_url?: string;
  html_url: string;
  number: number;
  pull_request?: { diff_url?: string; html_url?: string; url?: string };
  repository_url?: string;
  state?: 'closed' | 'open';
  state_reason?: string | null;
  title: string;
  updated_at: string;
  user: GitHubUserResponse | null;
}

export interface GitHubPullRequestResponse {
  body?: string | null;
  closed_at?: string | null;
  created_at: string;
  diff_url?: string;
  draft?: boolean;
  html_url: string;
  merged?: boolean;
  merged_at?: string | null;
  number: number;
  state?: 'closed' | 'open';
  title: string;
  updated_at: string;
  user: GitHubUserResponse | null;
}

export interface GitHubCommentResponse {
  body?: string | null;
  id: number;
  user: GitHubUserResponse | null;
}

export interface GitHubReviewResponse {
  id: number;
  state: string;
  user: GitHubUserResponse | null;
}

export interface GitHubUserResponse {
  login: string;
  name?: string | null;
}

export interface GitHubRawDocument {
  body: string;
  comments: Array<{ body: string; id: number; user: { login: string; name: string } }>;
  contentSignature?: string;
  created_at: string;
  diff?: { byteSize: number; sha256: string };
  html_url: string;
  kind: 'issue' | 'pull_request';
  lifecycle: GitHubDocumentLifecycle;
  number: number;
  repository: string;
  reviews: Array<{ id: number; state: string; user: { login: string; name: string } }>;
  title: string;
  updated_at: string;
  user: { login: string; name: string };
}

export type GitHubFetcher = (input: { path: string; token?: string }) => Promise<unknown>;

export type GitHubDiffFetcher = (input: { path: string; token?: string }) => Promise<string>;

export interface GitHubCandidate {
  issue: GitHubIssueResponse;
  pullRequest?: GitHubPullRequestResponse;
  repository: string;
}

export interface GitHubRawCandidate {
  body: string;
  raw: RawDocumentInput;
}

export interface CollectGitHubSourceOptions {
  dataSourceId?: string;
  diffFetcher?: GitHubDiffFetcher;
  dryRun?: boolean;
  fetcher?: GitHubFetcher;
  limit?: number;
  projectSlug: string;
  repository: CollectionRepository;
  storage: CollectionObjectStorage;
  token?: string;
}

export interface CollectGitHubSourceResult {
  decisions: Array<{
    dataSourceId: string;
    decision: CollectDecision | 'would_collect' | 'would_skip_existing';
    error?: string;
    rawDocumentId?: string;
    sourceId: string;
    sourceType: 'github';
  }>;
  dryRun: boolean;
  failureCount: number;
  projectSlug: string;
}

const GITHUB_PAGE_SIZE = 30;
const DEFAULT_MAX_PULL_REQUESTS = 500;
const DEFAULT_MAX_LINKED_ISSUES = 500;
const DEFAULT_USER_AGENT = 'pufu-lens-github-collector/0.1';

export async function collectGitHubSource(
  options: CollectGitHubSourceOptions,
): Promise<CollectGitHubSourceResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const fetcher = options.fetcher ?? fetchGitHubJson;
  const diffFetcher = options.diffFetcher ?? fetchGitHubText;
  const dataSources = await options.repository.findDataSources(
    project.id,
    'github',
    options.dataSourceId,
  );
  const decisions: CollectGitHubSourceResult['decisions'] = [];
  let remainingLimit = options.limit;

  for (const dataSource of dataSources.filter((source) => source.enabled)) {
    if (remainingLimit !== undefined && remainingLimit <= 0) {
      break;
    }

    const decisionStart = decisions.length;
    const scanLimit = remainingLimit;
    let scanHadFailure = false;
    const candidates = await scanGitHubDataSource({
      dataSource,
      fetcher,
      limit: remainingLimit,
      onFailure: () => {
        scanHadFailure = true;
      },
      token: options.token,
    });

    for (const candidate of candidates) {
      if (remainingLimit !== undefined && remainingLimit <= 0) {
        break;
      }
      if (remainingLimit !== undefined) {
        remainingLimit -= 1;
      }

      const fallbackSourceId = githubCandidateSourceId(candidate);
      let rawCandidate: GitHubRawCandidate;
      try {
        rawCandidate = await buildGitHubRawCandidate({
          candidate,
          dataSource,
          diffFetcher,
          fetcher,
          projectId: project.id,
          projectSlug: project.slug,
          token: options.token,
        });
      } catch (error) {
        const sanitizedError = sanitizeError(error);
        console.error(
          `Failed to build raw GitHub candidate for ${redactGitHubUri(
            candidate.issue.html_url,
          )}: ${sanitizedError}`,
        );
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'failed',
          error: sanitizedError,
          sourceId: fallbackSourceId,
          sourceType: 'github',
        });
        continue;
      }
      const sourceId = rawCandidate.raw.sourceId;
      const existing = await options.repository.lookupRawDocumentVersion({
        logicalSourceId: rawCandidate.raw.logicalSourceId,
        projectId: project.id,
        sourceType: 'github',
        sourceVersion: rawCandidate.raw.sourceVersion,
      });

      if (existing) {
        if (!options.dryRun) {
          await options.repository.linkDataSource({
            dataSourceId: dataSource.id,
            matchReason: 'github-source-match',
            metadata: { repository: candidate.repository },
            projectId: project.id,
            rawDocumentId: existing.id,
          });

          if (existing.ingestStatus === 'failed') {
            await options.repository.queueCandidate({
              dataSourceId: dataSource.id,
              projectId: project.id,
              rawDocumentId: existing.id,
              targetId: sourceId,
              targetUri: candidate.issue.html_url,
            });
          }
        }

        decisions.push({
          dataSourceId: dataSource.id,
          decision: options.dryRun
            ? 'would_skip_existing'
            : existing.ingestStatus === 'failed'
              ? 'queued_failed'
              : 'skipped_existing',
          rawDocumentId: existing.id,
          sourceId,
          sourceType: 'github',
        });
        continue;
      }

      if (options.dryRun) {
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'would_collect',
          sourceId,
          sourceType: 'github',
        });
        continue;
      }

      const sameHashCandidates = await options.repository.findSameHashCandidates({
        contentHash: rawCandidate.raw.contentHash,
        projectId: project.id,
        sourceType: 'github',
      });
      const stored = await options.storage.put(rawCandidate.raw.storageUri, rawCandidate.body, {
        contentType: rawCandidate.raw.mimeType,
      });
      const storedResult = await options.repository.upsertRawDocument({
        ...rawCandidate.raw,
        metadata: {
          ...rawCandidate.raw.metadata,
          sameAsCandidateRawDocumentIds: sameHashCandidates.map((raw) => raw.id),
        },
        storageUri: stored.uri,
      });

      await options.repository.linkDataSource({
        dataSourceId: dataSource.id,
        matchReason: 'github-source-match',
        metadata: { repository: candidate.repository },
        projectId: project.id,
        rawDocumentId: storedResult.rawDocument.id,
      });
      if (storedResult.inserted || storedResult.rawDocument.ingestStatus === 'failed') {
        await options.repository.queueCandidate({
          dataSourceId: dataSource.id,
          projectId: project.id,
          rawDocumentId: storedResult.rawDocument.id,
          targetId: sourceId,
          targetUri: rawCandidate.raw.sourceUri,
        });
      }

      decisions.push({
        dataSourceId: dataSource.id,
        decision: storedResult.inserted
          ? 'collected'
          : storedResult.rawDocument.ingestStatus === 'failed'
            ? 'queued_failed'
            : 'skipped_existing',
        rawDocumentId: storedResult.rawDocument.id,
        sourceId,
        sourceType: 'github',
      });
    }

    if (!options.dryRun) {
      await options.repository.markDataSourceChecked(dataSource.id);
      const scanFailed = decisions
        .slice(decisionStart)
        .some((decision) => decision.decision === 'failed');
      const scanTruncated = scanLimit !== undefined && candidates.length >= scanLimit;
      if (!scanFailed && !scanHadFailure && !scanTruncated) {
        await options.repository.completeDataSourceSync({
          dataSourceId: dataSource.id,
          projectId: project.id,
          syncCursor: completedSyncCursor('github'),
        });
      }
    }
  }

  return {
    decisions,
    dryRun: options.dryRun ?? false,
    failureCount: countFailedDecisions(decisions),
    projectSlug: project.slug,
  };
}

function countFailedDecisions(decisions: CollectGitHubSourceResult['decisions']): number {
  return decisions.filter((decision) => decision.decision === 'failed').length;
}

export async function scanGitHubDataSource(input: {
  dataSource: DataSourceRecord;
  fetcher: GitHubFetcher;
  limit?: number;
  onFailure?: () => void;
  token?: string;
}): Promise<GitHubCandidate[]> {
  const { dataSource, fetcher, limit, token } = input;
  if (dataSource.sourceType !== 'github' || !dataSource.enabled) {
    return [];
  }

  const repositories = readRepositories(dataSource.config);
  const includePullRequests = readBoolean(dataSource.config.includePullRequests, true);
  const includeLinkedIssues = readBoolean(dataSource.config.includeLinkedIssues, true);
  const includeStandaloneIssues = readBoolean(dataSource.config.includeIssues, false);
  const pullRequestState = readState(dataSource.config.pullRequestState ?? dataSource.config.state);
  const issueState = readIssueListState(dataSource.config.issueState ?? dataSource.config.state);
  const since = incrementalScanSince(dataSource);
  const candidates: GitHubCandidate[] = [];
  const seenSourceIds = new Set<string>();

  for (const repository of repositories) {
    if (limit !== undefined && candidates.length >= limit) {
      break;
    }

    if (includePullRequests) {
      const remainingLimit = remainingCandidateLimit(limit, candidates.length);
      const pullRequests = await listPullRequests({
        config: dataSource.config,
        fetcher,
        limit: remainingLimit,
        repository,
        since,
        state: pullRequestState,
        token,
      });
      for (const pullRequest of pullRequests) {
        if (limit !== undefined && candidates.length >= limit) {
          break;
        }
        addCandidate(
          candidates,
          seenSourceIds,
          { issue: pullRequestToIssue(pullRequest, repository), pullRequest, repository },
          dataSource.config,
        );
      }
      if (includeLinkedIssues && (limit === undefined || candidates.length < limit)) {
        const remainingLimit = remainingCandidateLimit(limit, candidates.length);
        const linkedIssues = await listLinkedIssues({
          config: dataSource.config,
          fetcher,
          limit: remainingLimit,
          onFailure: input.onFailure,
          pullRequests,
          repository,
          seenSourceIds,
          token,
        });
        for (const linkedIssue of linkedIssues) {
          if (limit !== undefined && candidates.length >= limit) {
            break;
          }
          addCandidate(candidates, seenSourceIds, linkedIssue, dataSource.config);
        }
      }
    }

    if (includeStandaloneIssues && (limit === undefined || candidates.length < limit)) {
      const remainingLimit = remainingCandidateLimit(limit, candidates.length);
      const issueList = await listIssues({
        fetcher,
        limit: remainingLimit,
        repository,
        since,
        state: issueState,
        token,
      });
      for (const issue of issueList) {
        if (limit !== undefined && candidates.length >= limit) {
          break;
        }
        addCandidate(candidates, seenSourceIds, { issue, repository }, dataSource.config);
      }
    }
  }

  return candidates;
}

async function listPullRequests(input: {
  config: Record<string, unknown>;
  fetcher: GitHubFetcher;
  limit?: number;
  repository: string;
  since?: string;
  state: 'all' | 'closed' | 'open';
  token?: string;
}): Promise<GitHubPullRequestResponse[]> {
  const maxPullRequests = Math.min(
    input.limit ?? readPositiveInteger(input.config.maxPullRequests, DEFAULT_MAX_PULL_REQUESTS),
    DEFAULT_MAX_PULL_REQUESTS,
  );
  const pullRequests: GitHubPullRequestResponse[] = [];
  for (let page = 1; pullRequests.length < maxPullRequests; page += 1) {
    const searchParams = new URLSearchParams({
      direction: 'desc',
      page: String(page),
      per_page: String(GITHUB_PAGE_SIZE),
      sort: 'updated',
      state: input.state,
    });
    const response = await input.fetcher({
      path: `/repos/${input.repository}/pulls?${searchParams.toString()}`,
      token: input.token,
    });
    const pageItems = validatePullRequestList(response);
    if (isPullRequestPageOlderThanSince(pageItems, input.since)) {
      break;
    }
    const filtered = filterPullRequestsSince(pageItems, input.since);
    pullRequests.push(...filtered.slice(0, maxPullRequests - pullRequests.length));
    if (filtered.length < pageItems.length || pageItems.length < GITHUB_PAGE_SIZE) {
      break;
    }
  }
  return pullRequests;
}

function isPullRequestPageOlderThanSince(
  pullRequests: GitHubPullRequestResponse[],
  since: string | undefined,
): boolean {
  if (!since || pullRequests.length === 0) {
    return false;
  }
  const sinceTime = Date.parse(since);
  const firstUpdatedTime = Date.parse(pullRequests[0]?.updated_at ?? '');
  return (
    !Number.isNaN(sinceTime) && !Number.isNaN(firstUpdatedTime) && firstUpdatedTime < sinceTime
  );
}

function filterPullRequestsSince(
  pullRequests: GitHubPullRequestResponse[],
  since: string | undefined,
): GitHubPullRequestResponse[] {
  if (!since) {
    return pullRequests;
  }
  const sinceTime = Date.parse(since);
  if (Number.isNaN(sinceTime)) {
    return pullRequests;
  }
  const filtered: GitHubPullRequestResponse[] = [];
  for (const pullRequest of pullRequests) {
    const updatedTime = Date.parse(pullRequest.updated_at);
    if (Number.isNaN(updatedTime) || updatedTime < sinceTime) {
      break;
    }
    filtered.push(pullRequest);
  }
  return filtered;
}

async function listIssues(input: {
  fetcher: GitHubFetcher;
  limit?: number;
  repository: string;
  since?: string;
  state: 'all' | 'closed' | 'open';
  token?: string;
}): Promise<GitHubIssueResponse[]> {
  const searchParams = new URLSearchParams({
    direction: 'desc',
    per_page: String(GITHUB_PAGE_SIZE),
    sort: 'updated',
    state: input.state,
  });
  if (input.since) {
    searchParams.set('since', input.since);
  }
  const issues = await input.fetcher({
    path: `/repos/${input.repository}/issues?${searchParams.toString()}`,
    token: input.token,
  });
  return validateIssueList(issues).slice(0, input.limit ?? GITHUB_PAGE_SIZE);
}

async function listLinkedIssues(input: {
  config: Record<string, unknown>;
  fetcher: GitHubFetcher;
  limit?: number;
  onFailure?: () => void;
  pullRequests: GitHubPullRequestResponse[];
  repository: string;
  seenSourceIds: Set<string>;
  token?: string;
}): Promise<GitHubCandidate[]> {
  const maxLinkedIssues = Math.min(
    readPositiveInteger(input.config.maxLinkedIssues, DEFAULT_MAX_LINKED_ISSUES),
    DEFAULT_MAX_LINKED_ISSUES,
  );
  const refs = uniqueLinkedIssueRefs(input.repository, input.pullRequests).slice(
    0,
    maxLinkedIssues,
  );
  const candidates: GitHubCandidate[] = [];
  for (const ref of refs) {
    if (input.limit !== undefined && candidates.length >= input.limit) {
      break;
    }
    const sourceId = normalizeSourceId(
      'github',
      `${ref.repository.toLowerCase()}/issues/${ref.number}`,
    );
    if (input.seenSourceIds.has(sourceId)) {
      continue;
    }
    let issue: GitHubIssueResponse;
    try {
      issue = validateIssue(
        await input.fetcher({
          path: `/repos/${ref.repository}/issues/${ref.number}`,
          token: input.token,
        }),
      );
    } catch (error) {
      input.onFailure?.();
      console.error(
        `Failed to fetch linked GitHub issue ${ref.repository}#${ref.number}: ${sanitizeError(
          error,
        )}`,
      );
      continue;
    }
    if (!issue.pull_request) {
      candidates.push({ issue, repository: ref.repository });
    }
  }
  return candidates;
}

function remainingCandidateLimit(
  limit: number | undefined,
  collectedCount: number,
): number | undefined {
  return limit === undefined ? undefined : Math.max(limit - collectedCount, 0);
}

function addCandidate(
  candidates: GitHubCandidate[],
  seenSourceIds: Set<string>,
  candidate: GitHubCandidate,
  config: Record<string, unknown>,
): void {
  if (!shouldIncludeIssue(candidate.issue, config)) {
    return;
  }
  const sourceId = githubCandidateSourceId(candidate);
  if (seenSourceIds.has(sourceId)) {
    return;
  }
  seenSourceIds.add(sourceId);
  candidates.push(candidate);
}

export async function buildGitHubRawCandidate(input: {
  candidate: GitHubCandidate;
  dataSource: DataSourceRecord;
  diffFetcher: GitHubDiffFetcher;
  fetcher: GitHubFetcher;
  projectId: string;
  projectSlug: string;
  token?: string;
}): Promise<GitHubRawCandidate> {
  const { candidate, diffFetcher, fetcher, token } = input;
  const issue = candidate.issue;
  const kind = issue.pull_request ? 'pull_request' : 'issue';
  const commentsPromise = fetcher({
    path: `/repos/${candidate.repository}/issues/${issue.number}/comments`,
    token,
  });
  const reviewsPromise =
    kind === 'pull_request'
      ? fetcher({
          path: `/repos/${candidate.repository}/pulls/${issue.number}/reviews`,
          token,
        })
      : Promise.resolve([]);
  const diffPromise =
    kind === 'pull_request'
      ? safeFetchDiff({
          diffFetcher,
          path: `/repos/${candidate.repository}/pulls/${issue.number}`,
          token,
        })
      : Promise.resolve(undefined);
  const [comments, reviews, diff] = await Promise.all([
    commentsPromise,
    reviewsPromise,
    diffPromise,
  ]);
  const validatedComments = validateCommentList(comments);

  const rawDocument: GitHubRawDocument = {
    body: issue.body ?? '',
    comments: validatedComments.map((comment) => ({
      body: comment.body ?? '',
      id: comment.id,
      user: githubUser(comment.user),
    })),
    contentSignature: githubRawContentSignature({
      body: issue.body ?? '',
      comments: validatedComments.map((comment) => ({
        body: comment.body ?? '',
      })),
      title: issue.title,
    }),
    created_at: issue.created_at,
    diff,
    html_url: issue.html_url,
    kind,
    lifecycle: normalizeGitHubDocumentLifecycle({
      issue,
      kind,
      pullRequest: candidate.pullRequest,
    }),
    number: issue.number,
    repository: candidate.repository,
    reviews: validateReviewList(reviews).map((review) => ({
      id: review.id,
      state: review.state,
      user: githubUser(review.user),
    })),
    title: issue.title,
    updated_at: issue.updated_at,
    user: githubUser(issue.user),
  };
  const body = `${JSON.stringify(rawDocument, null, 2)}\n`;
  const contentHash = sha256Hex(body);
  const fetchedAt = new Date().toISOString();
  const logicalSourceId = githubLogicalSourceId({
    kind,
    number: issue.number,
    repository: candidate.repository,
  });
  const sourceVersion = githubSourceVersion(issue.updated_at, contentHash);
  const sourceId = `${logicalSourceId}:${sourceVersion}`;

  return {
    body,
    raw: {
      byteSize: Buffer.byteLength(body),
      contentHash,
      logicalSourceId,
      metadata: {
        commentCount: rawDocument.comments.length,
        contentSignature: rawDocument.contentSignature,
        dataSourceId: input.dataSource.id,
        fetchedAt,
        hasDiff: Boolean(diff),
        kind,
        number: issue.number,
        repository: candidate.repository,
        reviewCount: rawDocument.reviews.length,
        updatedAt: issue.updated_at,
        ...githubLifecycleMetadata(rawDocument.lifecycle),
      },
      mimeType: 'application/json',
      projectId: input.projectId,
      sourceId,
      sourceType: 'github',
      sourceUri: issue.html_url,
      sourceVersion,
      storageUri: `${input.projectSlug}/raw/github/${safeStorageSegment(sourceId)}.json`,
    },
  };
}

function githubCandidateSourceId(candidate: GitHubCandidate): string {
  const kind = candidate.issue.pull_request ? 'pull_request' : 'issue';
  return normalizeSourceId(
    'github',
    `${candidate.repository.toLowerCase()}/${kind === 'pull_request' ? 'pulls' : 'issues'}/${
      candidate.issue.number
    }`,
  );
}

/** GitHub REST API failure with HTTP status and optional rate-limit metadata. */
export class GitHubApiRequestError extends Error {
  readonly rateLimitRemaining?: number;
  readonly status: number;

  constructor(input: { path: string; rateLimitRemaining?: number; status: number }) {
    super(`GitHub API request failed with status ${input.status}`);
    this.name = 'GitHubApiRequestError';
    this.status = input.status;
    this.rateLimitRemaining = input.rateLimitRemaining;
  }
}

function readGitHubRateLimitRemaining(headers: Headers): number | undefined {
  const remainingHeader = headers.get('x-ratelimit-remaining');
  const parsedRemaining =
    remainingHeader !== null && remainingHeader !== '' ? Number(remainingHeader) : undefined;
  return Number.isFinite(parsedRemaining) ? parsedRemaining : undefined;
}

function createGitHubApiRequestError(input: {
  path: string;
  response: Response;
}): GitHubApiRequestError {
  return new GitHubApiRequestError({
    path: input.path,
    rateLimitRemaining: readGitHubRateLimitRemaining(input.response.headers),
    status: input.response.status,
  });
}

/**
 * Fetches JSON from the GitHub REST API.
 *
 * @param input.path - API path beginning with `/`, excluding `https://api.github.com`
 * @param input.token - Optional bearer token for authenticated requests
 * @returns Parsed JSON response body
 * @throws {GitHubApiRequestError} When GitHub returns a non-2xx status, including optional
 *   finite `x-ratelimit-remaining` metadata on the error
 */
export async function fetchGitHubJson(input: { path: string; token?: string }): Promise<unknown> {
  const response = await fetchWithRetry(`https://api.github.com${input.path}`, {
    headers: githubHeaders(input.token),
  });
  if (!response.ok) {
    throw createGitHubApiRequestError({ path: input.path, response });
  }
  return response.json();
}

/**
 * Fetches a GitHub REST diff/text response.
 *
 * @param input.path - API path beginning with `/`, excluding `https://api.github.com`
 * @param input.token - Optional bearer token for authenticated requests
 * @returns Raw response body text
 * @throws {GitHubApiRequestError} When GitHub returns a non-2xx status, including optional
 *   finite `x-ratelimit-remaining` metadata on the error
 */
export async function fetchGitHubText(input: { path: string; token?: string }): Promise<string> {
  const response = await fetchWithRetry(`https://api.github.com${input.path}`, {
    headers: { ...githubHeaders(input.token), accept: 'application/vnd.github.v3.diff' },
  });
  if (!response.ok) {
    throw createGitHubApiRequestError({ path: input.path, response });
  }
  return response.text();
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'user-agent': DEFAULT_USER_AGENT,
    'x-github-api-version': '2022-11-28',
  };
}

async function safeFetchDiff(input: {
  diffFetcher: GitHubDiffFetcher;
  path: string;
  token?: string;
}): Promise<{ byteSize: number; sha256: string } | undefined> {
  try {
    const diffText = await input.diffFetcher({ path: input.path, token: input.token });
    return {
      byteSize: Buffer.byteLength(diffText),
      sha256: sha256Hex(diffText),
    };
  } catch (error) {
    console.error(`Failed to fetch GitHub diff for ${input.path}: ${sanitizeError(error)}`);
    throw error;
  }
}

function readRepositories(config: Record<string, unknown>): string[] {
  const repositories = [
    ...readStringArray(config.repositories),
    ...readStringArray(config.repos),
    ...readSingleString(config.repository),
    ...readSingleString(config.repo),
  ]
    .map((repository) => repository.trim())
    .filter((repository) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository));
  return [...new Set(repositories)];
}

function readState(value: unknown): 'all' | 'closed' | 'open' {
  return value === 'all' || value === 'closed' || value === 'open' ? value : 'all';
}

function readIssueListState(value: unknown): 'all' | 'closed' | 'open' {
  return value === 'all' || value === 'closed' || value === 'open' ? value : 'open';
}

function shouldIncludeIssue(issue: GitHubIssueResponse, config: Record<string, unknown>): boolean {
  const isPullRequest = Boolean(issue.pull_request);
  const includePullRequests = readBoolean(config.includePullRequests, true);
  const includeIssues = readBoolean(config.includeIssues, false);
  const includeLinkedIssues = readBoolean(config.includeLinkedIssues, true);
  if (isPullRequest && !includePullRequests) {
    return false;
  }
  if (!isPullRequest && !includeIssues && !includeLinkedIssues) {
    return false;
  }

  const numbers = readNumberArray(config.numbers);
  return numbers.length === 0 || numbers.includes(issue.number);
}

function validateIssueList(value: unknown): GitHubIssueResponse[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub issues response must be an array.');
  }
  return value.map((item) => validateIssue(item));
}

function validateIssue(value: unknown): GitHubIssueResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('GitHub issue response item must be an object.');
  }
  const item = value as Record<string, unknown>;
  return {
    body: readNullableString(item.body),
    closed_at: readNullableString(item.closed_at),
    comments_url: readString(item.comments_url),
    created_at: requiredString(item.created_at, 'created_at'),
    diff_url: readString(item.diff_url),
    html_url: requiredString(item.html_url, 'html_url'),
    number: requiredNumber(item.number, 'number'),
    pull_request:
      typeof item.pull_request === 'object' && item.pull_request !== null
        ? (item.pull_request as GitHubIssueResponse['pull_request'])
        : undefined,
    repository_url: readString(item.repository_url),
    state: readIssueState(item.state),
    state_reason: readNullableString(item.state_reason),
    title: requiredString(item.title, 'title'),
    updated_at: requiredString(item.updated_at, 'updated_at'),
    user: validateUser(item.user),
  };
}

function validatePullRequestList(value: unknown): GitHubPullRequestResponse[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub pull requests response must be an array.');
  }
  return value.map((item) => validatePullRequest(item));
}

function validatePullRequest(value: unknown): GitHubPullRequestResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('GitHub pull request response item must be an object.');
  }
  const item = value as Record<string, unknown>;
  return {
    body: readNullableString(item.body),
    closed_at: readNullableString(item.closed_at),
    created_at: requiredString(item.created_at, 'created_at'),
    diff_url: readString(item.diff_url),
    draft: typeof item.draft === 'boolean' ? item.draft : undefined,
    html_url: requiredString(item.html_url, 'html_url'),
    merged: typeof item.merged === 'boolean' ? item.merged : undefined,
    merged_at: readNullableString(item.merged_at),
    number: requiredNumber(item.number, 'number'),
    state: readIssueState(item.state),
    title: requiredString(item.title, 'title'),
    updated_at: requiredString(item.updated_at, 'updated_at'),
    user: validateUser(item.user),
  };
}

function pullRequestToIssue(
  pullRequest: GitHubPullRequestResponse,
  repository: string,
): GitHubIssueResponse {
  return {
    body: pullRequest.body,
    closed_at: pullRequest.closed_at,
    created_at: pullRequest.created_at,
    diff_url: pullRequest.diff_url,
    html_url: pullRequest.html_url,
    number: pullRequest.number,
    pull_request: {
      diff_url: pullRequest.diff_url,
      html_url: pullRequest.html_url,
    },
    repository_url: `https://api.github.com/repos/${repository}`,
    state: pullRequest.state,
    title: pullRequest.title,
    updated_at: pullRequest.updated_at,
    user: pullRequest.user,
  };
}

function validateCommentList(value: unknown): GitHubCommentResponse[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub comments response must be an array.');
  }
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('GitHub comment response item must be an object.');
    }
    const comment = item as Record<string, unknown>;
    return {
      body: readNullableString(comment.body),
      id: requiredNumber(comment.id, 'comment.id'),
      user: validateUser(comment.user),
    };
  });
}

function validateReviewList(value: unknown): GitHubReviewResponse[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub reviews response must be an array.');
  }
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('GitHub review response item must be an object.');
    }
    const review = item as Record<string, unknown>;
    return {
      id: requiredNumber(review.id, 'review.id'),
      state: requiredString(review.state, 'review.state'),
      user: validateUser(review.user),
    };
  });
}

function validateUser(value: unknown): GitHubUserResponse {
  if (value === null || value === undefined) {
    return { login: 'ghost', name: 'Ghost' };
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('GitHub user must be an object.');
  }
  const user = value as Record<string, unknown>;
  return {
    login: requiredString(user.login, 'user.login'),
    name: readNullableString(user.name),
  };
}

function githubUser(user: GitHubUserResponse | null): {
  login: string;
  name: string;
} {
  if (!user) {
    return { login: 'ghost', name: 'Ghost' };
  }
  return {
    login: user.login,
    name: user.name?.trim() || user.login,
  };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is number => Number.isInteger(item));
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null ? null : readString(value);
}

function readSingleString(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readIssueState(value: unknown): 'closed' | 'open' | undefined {
  return value === 'closed' || value === 'open' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueLinkedIssueRefs(
  defaultRepository: string,
  pullRequests: GitHubPullRequestResponse[],
): Array<{ repository: string; number: number }> {
  const refs = new Map<string, { repository: string; number: number }>();
  for (const pullRequest of pullRequests) {
    for (const ref of extractLinkedIssueRefs(
      `${pullRequest.title}\n${pullRequest.body ?? ''}`,
      defaultRepository,
    )) {
      refs.set(`${ref.repository.toLowerCase()}#${ref.number}`, ref);
    }
  }
  return [...refs.values()];
}

function extractLinkedIssueRefs(
  text: string,
  defaultRepository: string,
): Array<{ repository: string; number: number }> {
  const refs: Array<{ repository: string; number: number }> = [];
  const keywordPattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+(?:\s*,\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)*)/gi;
  for (const match of text.matchAll(keywordPattern)) {
    for (const refText of (match[1] ?? '').split(/\s*,\s*/)) {
      const ref = parseIssueRef(refText, defaultRepository);
      if (ref) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

function parseIssueRef(
  value: string,
  defaultRepository: string,
): { repository: string; number: number } | undefined {
  const match = value.match(
    /^(?:(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(?<number>[1-9]\d*)$/,
  );
  if (!match?.groups) {
    return undefined;
  }
  return {
    number: Number(match.groups.number),
    repository: match.groups.repository ?? defaultRepository,
  };
}

function requiredNumber(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`GitHub response field ${field} must be an integer.`);
  }
  return Number(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`GitHub response field ${field} must be a string.`);
  }
  return value;
}

function safeStorageSegment(value: string): string {
  const hash = sha256Hex(value).slice(0, 12);
  const clean = normalizeStorageSegment(value, 107);
  return clean ? `${clean}-${hash}` : hash;
}

function normalizeStorageSegment(value: string, maxLength: number): string {
  let output = '';
  let lastWasDash = false;
  for (const char of value.toLowerCase()) {
    if (isSafeStorageChar(char)) {
      output += char;
      lastWasDash = false;
    } else if (!lastWasDash) {
      output += '-';
      lastWasDash = true;
    }
    if (output.length >= maxLength) {
      break;
    }
  }
  return trimDashes(output);
}

function isSafeStorageChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= '0' && char <= '9') ||
    char === '.' ||
    char === '_' ||
    char === '-'
  );
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') {
    start += 1;
  }
  while (end > start && value[end - 1] === '-') {
    end -= 1;
  }
  return value.slice(start, end);
}

function redactGitHubUri(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    return url.toString();
  } catch {
    return '<invalid-github-url>';
  }
}

function sanitizeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(token|secret|api[_-]?key)=\S+/gi, '$1=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .slice(0, 500);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
