import { createHash } from 'node:crypto';
import type {
  CollectDecision,
  CollectionObjectStorage,
  CollectionRepository,
  DataSourceRecord,
  RawDocumentInput,
} from './collection-pipeline.js';
import { normalizeSourceId } from './collection-pipeline.js';

export interface GitHubIssueResponse {
  body?: string | null;
  comments_url?: string;
  created_at: string;
  diff_url?: string;
  html_url: string;
  number: number;
  pull_request?: { diff_url?: string; html_url?: string; url?: string };
  repository_url?: string;
  title: string;
  updated_at: string;
  user: { login: string; name?: string | null };
}

export interface GitHubCommentResponse {
  body?: string | null;
  id: number;
  user: { login: string; name?: string | null };
}

export interface GitHubReviewResponse {
  id: number;
  state: string;
  user: { login: string; name?: string | null };
}

export interface GitHubRawDocument {
  body: string;
  comments: Array<{ body: string; id: number; user: { login: string; name: string } }>;
  created_at: string;
  diff?: { byteSize: number; sha256: string };
  html_url: string;
  kind: 'issue' | 'pull_request';
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
  repository: string;
}

export interface GitHubRawCandidate {
  body: string;
  raw: RawDocumentInput;
}

export interface CollectGitHubSourceOptions {
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
    rawDocumentId?: string;
    sourceId: string;
    sourceType: 'github';
  }>;
  dryRun: boolean;
  projectSlug: string;
}

const DEFAULT_PER_PAGE = 30;
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
  const dataSources = await options.repository.findDataSources(project.id, 'github');
  const decisions: CollectGitHubSourceResult['decisions'] = [];
  let remainingLimit = options.limit;

  for (const dataSource of dataSources.filter((source) => source.enabled)) {
    if (remainingLimit !== undefined && remainingLimit <= 0) {
      break;
    }

    const candidates = await scanGitHubDataSource({
      dataSource,
      fetcher,
      limit: remainingLimit,
      token: options.token,
    });

    for (const candidate of candidates) {
      if (remainingLimit !== undefined && remainingLimit <= 0) {
        break;
      }
      if (remainingLimit !== undefined) {
        remainingLimit -= 1;
      }

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
        console.error(
          `Failed to build raw GitHub candidate for ${redactGitHubUri(
            candidate.issue.html_url,
          )}: ${sanitizeError(error)}`,
        );
        continue;
      }

      const sourceId = rawCandidate.raw.sourceId;
      const existing = await options.repository.lookupRawDocument({
        projectId: project.id,
        sourceId,
        sourceType: 'github',
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
              targetUri: rawCandidate.raw.sourceUri,
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
      const rawDocument = await options.repository.upsertRawDocument({
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
        rawDocumentId: rawDocument.id,
      });
      await options.repository.queueCandidate({
        dataSourceId: dataSource.id,
        projectId: project.id,
        rawDocumentId: rawDocument.id,
        targetId: sourceId,
        targetUri: rawCandidate.raw.sourceUri,
      });

      decisions.push({
        dataSourceId: dataSource.id,
        decision: 'collected',
        rawDocumentId: rawDocument.id,
        sourceId,
        sourceType: 'github',
      });
    }

    if (!options.dryRun) {
      await options.repository.markDataSourceChecked(dataSource.id);
    }
  }

  return { decisions, dryRun: options.dryRun ?? false, projectSlug: project.slug };
}

export async function scanGitHubDataSource(input: {
  dataSource: DataSourceRecord;
  fetcher: GitHubFetcher;
  limit?: number;
  token?: string;
}): Promise<GitHubCandidate[]> {
  const { dataSource, fetcher, limit, token } = input;
  if (dataSource.sourceType !== 'github' || !dataSource.enabled) {
    return [];
  }

  const repositories = readRepositories(dataSource.config);
  const state = readState(dataSource.config.state);
  const since = readString(dataSource.ingestWindow.since);
  const candidates: GitHubCandidate[] = [];

  for (const repository of repositories) {
    if (limit !== undefined && candidates.length >= limit) {
      break;
    }

    const searchParams = new URLSearchParams({
      direction: 'desc',
      per_page: String(Math.min(limit ?? DEFAULT_PER_PAGE, DEFAULT_PER_PAGE)),
      sort: 'updated',
      state,
    });
    if (since) {
      searchParams.set('since', since);
    }
    const issues = await fetcher({
      path: `/repos/${repository}/issues?${searchParams.toString()}`,
      token,
    });
    const issueList = validateIssueList(issues);

    for (const issue of issueList) {
      if (limit !== undefined && candidates.length >= limit) {
        break;
      }
      if (!shouldIncludeIssue(issue, dataSource.config)) {
        continue;
      }
      candidates.push({ issue, repository });
    }
  }

  return candidates;
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
  const comments = await fetcher({
    path: `/repos/${candidate.repository}/issues/${issue.number}/comments`,
    token,
  });
  const reviews =
    kind === 'pull_request'
      ? await fetcher({
          path: `/repos/${candidate.repository}/pulls/${issue.number}/reviews`,
          token,
        })
      : [];
  const diff =
    kind === 'pull_request'
      ? await safeFetchDiff({
          diffFetcher,
          path: `/repos/${candidate.repository}/pulls/${issue.number}`,
          token,
        })
      : undefined;

  const rawDocument: GitHubRawDocument = {
    body: issue.body ?? '',
    comments: validateCommentList(comments).map((comment) => ({
      body: comment.body ?? '',
      id: comment.id,
      user: githubUser(comment.user),
    })),
    created_at: issue.created_at,
    diff,
    html_url: issue.html_url,
    kind,
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
  const sourceId = normalizeSourceId(
    'github',
    `${candidate.repository}/${kind === 'pull_request' ? 'pulls' : 'issues'}/${issue.number}`,
  );
  const fetchedAt = new Date().toISOString();

  return {
    body,
    raw: {
      byteSize: Buffer.byteLength(body),
      contentHash,
      metadata: {
        commentCount: rawDocument.comments.length,
        dataSourceId: input.dataSource.id,
        fetchedAt,
        hasDiff: Boolean(diff),
        kind,
        number: issue.number,
        repository: candidate.repository,
        reviewCount: rawDocument.reviews.length,
        updatedAt: issue.updated_at,
      },
      mimeType: 'application/json',
      projectId: input.projectId,
      sourceId,
      sourceType: 'github',
      sourceUri: issue.html_url,
      storageUri: `${input.projectSlug}/raw/github/${safeStorageSegment(sourceId)}.json`,
    },
  };
}

export async function fetchGitHubJson(input: { path: string; token?: string }): Promise<unknown> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    headers: githubHeaders(input.token),
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}: ${input.path}`);
  }
  return response.json();
}

export async function fetchGitHubText(input: { path: string; token?: string }): Promise<string> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    headers: { ...githubHeaders(input.token), accept: 'application/vnd.github.v3.diff' },
  });
  if (!response.ok) {
    throw new Error(`GitHub diff request failed with status ${response.status}: ${input.path}`);
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
  } catch {
    return undefined;
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
  return value === 'all' || value === 'closed' || value === 'open' ? value : 'open';
}

function shouldIncludeIssue(issue: GitHubIssueResponse, config: Record<string, unknown>): boolean {
  const isPullRequest = Boolean(issue.pull_request);
  const includePullRequests = readBoolean(config.includePullRequests, true);
  const includeIssues = readBoolean(config.includeIssues, true);
  if (isPullRequest && !includePullRequests) {
    return false;
  }
  if (!isPullRequest && !includeIssues) {
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
    title: requiredString(item.title, 'title'),
    updated_at: requiredString(item.updated_at, 'updated_at'),
    user: validateUser(item.user),
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

function validateUser(value: unknown): { login: string; name?: string | null } {
  if (typeof value !== 'object' || value === null) {
    throw new Error('GitHub user must be an object.');
  }
  const user = value as Record<string, unknown>;
  return {
    login: requiredString(user.login, 'user.login'),
    name: readNullableString(user.name),
  };
}

function githubUser(user: { login: string; name?: string | null }): {
  login: string;
  name: string;
} {
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
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
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 107);
  return clean ? `${clean}-${hash}` : hash;
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
