import { createHash } from 'node:crypto';
import type {
  CollectDecision,
  CollectionObjectStorage,
  CollectionRepository,
  DataSourceRecord,
  RawDocumentInput,
} from './collection-pipeline.js';
import { completedSyncCursor, normalizeSourceId } from './collection-pipeline.js';
import { fetchWithRetry } from './http-retry.js';
import { webLogicalSourceId, webSourceVersion } from './source-version-identity.js';

export interface WebUrlFetchResponse {
  body: string;
  contentType?: string;
  finalUrl: string;
  status: number;
}

export type WebUrlFetcher = (url: string) => Promise<WebUrlFetchResponse>;

export interface WebUrlCandidate {
  sourceUri: string;
}

export interface WebUrlRawCandidate {
  body: string;
  raw: RawDocumentInput;
}

export interface CollectWebUrlSourceOptions {
  dataSourceId?: string;
  dryRun?: boolean;
  fetcher?: WebUrlFetcher;
  limit?: number;
  projectSlug: string;
  repository: CollectionRepository;
  storage: CollectionObjectStorage;
}

export interface CollectWebUrlSourceResult {
  decisions: Array<{
    dataSourceId: string;
    decision: CollectDecision | 'would_collect' | 'would_skip_existing';
    error?: string;
    rawDocumentId?: string;
    sourceId: string;
    sourceType: 'web';
  }>;
  dryRun: boolean;
  failureCount: number;
  projectSlug: string;
}

const DEFAULT_USER_AGENT = 'pufu-lens-web-collector/0.1';

export async function collectWebUrlSource(
  options: CollectWebUrlSourceOptions,
): Promise<CollectWebUrlSourceResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const fetcher = options.fetcher ?? fetchWebUrl;
  const dataSources = await options.repository.findDataSources(
    project.id,
    'web',
    options.dataSourceId,
  );
  const decisions: CollectWebUrlSourceResult['decisions'] = [];
  let remainingLimit = options.limit;

  for (const dataSource of dataSources.filter((source) => source.enabled)) {
    if (remainingLimit !== undefined && remainingLimit <= 0) {
      break;
    }

    const decisionStart = decisions.length;
    let scanTruncated = false;
    const candidates = scanWebUrlDataSource(dataSource);

    for (const candidate of candidates) {
      if (remainingLimit !== undefined && remainingLimit <= 0) {
        scanTruncated = true;
        break;
      }

      let rawCandidate: WebUrlRawCandidate;
      const fallbackSourceId = webFailureSourceId(candidate.sourceUri);
      try {
        rawCandidate = await buildWebUrlRawCandidate({
          candidate,
          dataSource,
          fetcher,
          projectId: project.id,
          projectSlug: project.slug,
        });
      } catch (error) {
        const sanitizedError = sanitizeError(error);
        console.error(
          `Failed to build raw web candidate for ${redactUrl(
            candidate.sourceUri,
          )}: ${sanitizedError}`,
        );
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'failed',
          error: sanitizedError,
          sourceId: fallbackSourceId,
          sourceType: 'web',
        });
        continue;
      }
      const sourceId = rawCandidate.raw.sourceId;
      const existing = await options.repository.lookupRawDocumentVersion({
        logicalSourceId: rawCandidate.raw.logicalSourceId,
        projectId: project.id,
        sourceType: 'web',
        sourceVersion: rawCandidate.raw.sourceVersion,
      });

      if (existing) {
        if (!options.dryRun) {
          await options.repository.linkDataSource({
            dataSourceId: dataSource.id,
            matchReason: 'web-url-source-match',
            metadata: webLinkMetadata(candidate, rawCandidate),
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
          sourceType: 'web',
        });
        continue;
      }

      if (options.dryRun) {
        if (remainingLimit !== undefined) {
          remainingLimit -= 1;
        }
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'would_collect',
          sourceId,
          sourceType: 'web',
        });
        continue;
      }

      const sameHashCandidates = await options.repository.findSameHashCandidates({
        contentHash: rawCandidate.raw.contentHash,
        projectId: project.id,
        sourceType: 'web',
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
        matchReason: 'web-url-source-match',
        metadata: webLinkMetadata(candidate, rawCandidate),
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
        sourceType: 'web',
      });
      if (
        remainingLimit !== undefined &&
        (storedResult.inserted || storedResult.rawDocument.ingestStatus === 'failed')
      ) {
        remainingLimit -= 1;
      }
    }

    if (!options.dryRun) {
      await options.repository.markDataSourceChecked(dataSource.id);
      const scanFailed = decisions
        .slice(decisionStart)
        .some((decision) => decision.decision === 'failed');
      if (!scanFailed && !scanTruncated) {
        await options.repository.completeDataSourceSync({
          dataSourceId: dataSource.id,
          projectId: project.id,
          syncCursor: completedSyncCursor('web'),
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

function webLinkMetadata(
  candidate: WebUrlCandidate,
  rawCandidate: WebUrlRawCandidate,
): Record<string, unknown> {
  return {
    canonicalUrl: rawCandidate.raw.metadata.canonicalUrl,
    finalUrl: rawCandidate.raw.metadata.finalUrl,
    sourceUri: candidate.sourceUri,
  };
}

function countFailedDecisions(decisions: CollectWebUrlSourceResult['decisions']): number {
  return decisions.filter((decision) => decision.decision === 'failed').length;
}

export function scanWebUrlDataSource(
  dataSource: DataSourceRecord,
  limit?: number,
): WebUrlCandidate[] {
  if (dataSource.sourceType !== 'web' || !dataSource.enabled) {
    return [];
  }

  const urls = [
    ...readSingleString(dataSource.config.url),
    ...readStringArray(dataSource.config.urls),
    ...readStringArray(dataSource.config.sourceUris),
    ...readStringArray(dataSource.config.sourceUrls),
  ];
  const normalizedUrls: string[] = [];
  for (const url of urls) {
    try {
      normalizedUrls.push(normalizeHttpUrl(url));
    } catch (error) {
      console.warn(`Skipped invalid web URL ${redactUrl(url)}: ${sanitizeError(error)}`);
    }
  }
  const uniqueUrls = [...new Set(normalizedUrls)];
  return uniqueUrls.slice(0, limit ?? uniqueUrls.length).map((sourceUri) => ({ sourceUri }));
}

export async function buildWebUrlRawCandidate(input: {
  candidate: WebUrlCandidate;
  dataSource: DataSourceRecord;
  fetcher: WebUrlFetcher;
  projectId: string;
  projectSlug: string;
}): Promise<WebUrlRawCandidate> {
  const fetched = await input.fetcher(input.candidate.sourceUri);
  if (fetched.status < 200 || fetched.status >= 300) {
    throw new Error(
      `Web URL fetch failed with status ${fetched.status}: ${input.candidate.sourceUri}`,
    );
  }

  const finalUrl = normalizeHttpUrl(fetched.finalUrl);
  const canonicalUrl = extractCanonicalUrl(fetched.body, finalUrl);
  const logicalSourceId = webLogicalSourceId(input.candidate.sourceUri);
  const fetchedAt = new Date().toISOString();
  const contentHash = sha256Hex(fetched.body);
  const sourceVersion = webSourceVersion(contentHash);
  const canonicalSourceId = normalizeSourceId('web', canonicalUrl);
  const sourceId = `${logicalSourceId}#pufu-version=${sourceVersion}`;
  const mimeType = normalizeWebMimeType(fetched.contentType);

  return {
    body: fetched.body,
    raw: {
      byteSize: Buffer.byteLength(fetched.body),
      contentHash,
      logicalSourceId,
      metadata: {
        canonicalUrl: canonicalSourceId,
        configuredUrl: logicalSourceId,
        fetchedAt,
        finalUrl,
        httpStatus: fetched.status,
        dataSourceId: input.dataSource.id,
        title: extractTitle(fetched.body),
      },
      mimeType,
      projectId: input.projectId,
      sourceId,
      sourceType: 'web',
      sourceUri: finalUrl,
      sourceVersion,
      storageUri: `${input.projectSlug}/raw/web/${safeStorageSegment(sourceId)}.html`,
    },
  };
}

export async function fetchWebUrl(url: string): Promise<WebUrlFetchResponse> {
  const response = await fetchWithRetry(url, {
    headers: { 'user-agent': DEFAULT_USER_AGENT },
    redirect: 'follow',
  });
  const contentType = response.headers.get('content-type') ?? undefined;
  const buffer = await response.arrayBuffer();

  return {
    body: decodeWebResponse(buffer, contentType),
    contentType,
    finalUrl: response.url,
    status: response.status,
  };
}

function extractCanonicalUrl(html: string, baseUrl: string): string {
  const canonicalLink = [...html.matchAll(/<link\s+[^>]*>/gi)]
    .map((match) => match[0])
    .find((link) => getHtmlAttribute(link, 'rel')?.toLowerCase() === 'canonical');
  const href = canonicalLink ? getHtmlAttribute(canonicalLink, 'href') : undefined;
  if (!href) {
    return baseUrl;
  }
  try {
    return normalizeHttpUrl(new URL(href, baseUrl).toString());
  } catch {
    return baseUrl;
  }
}

function extractTitle(html: string): string | undefined {
  const title = html.match(/<title(?:\s[^>]*)?>(?<title>.*?)<\/title>/is)?.groups?.title;
  return title?.replace(/\s+/g, ' ').trim();
}

function getHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const pattern = new RegExp(
    `\\s${attributeName}\\s*=\\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<unquoted>[^\\s>]+))`,
    'i',
  );
  const match = tag.match(pattern);
  return match?.groups?.double ?? match?.groups?.single ?? match?.groups?.unquoted;
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Web URL must use http or https: ${value}`);
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== '/') {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

function normalizeWebMimeType(contentType: string | undefined): string {
  const [mimeType] = (contentType ?? 'text/html').split(';', 1);
  return mimeType?.trim().toLowerCase() || 'text/html';
}

function readSingleString(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function safeStorageSegment(value: string): string {
  const hash = sha256Hex(value).slice(0, 12);
  const clean = value
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 107);
  return clean ? `${clean}-${hash}` : hash;
}

function decodeWebResponse(buffer: ArrayBuffer, contentType: string | undefined): string {
  const charset = readCharset(contentType);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function readCharset(contentType: string | undefined): string {
  const charset = contentType?.match(/charset\s*=\s*["']?(?<charset>[\w-]+)/i)?.groups?.charset;
  return charset ?? 'utf-8';
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.search) {
      url.search = '?<redacted>';
    }
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function webFailureSourceId(sourceUri: string): string {
  try {
    return normalizeSourceId('web', sourceUri);
  } catch {
    return `invalid-web-url:${sha256Hex(sourceUri).slice(0, 16)}`;
  }
}

function sanitizeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/(token|secret|api[_-]?key)=\S+/gi, '$1=<redacted>')
    .slice(0, 500);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
