import { Article } from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import {
  assertInboundReportHttpsUrl,
  assertInboundReportRawSummary,
  assertInboundReportTitle,
  assertInboundReportUrlAllowed,
  sanitizeInboundReportSummaryHtml,
} from './inbound-report-sanitizer.ts';
import {
  type BlockedDomainPredicate,
  type CreateBoundedRemoteJsonFetcherInput,
  createBoundedRemoteJsonFetcher,
} from './remote-document.ts';
import { createProductionSafeDocumentLoader } from './security.ts';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** Fedify-preloaded ActivityStreams context URLs permitted on inbound Article documents. */
const ALLOWED_REMOTE_ARTICLE_CONTEXT_URLS = new Set(['https://www.w3.org/ns/activitystreams']);

/** Resolved remote Article metadata for inbound report mapping. */
export type RemoteArticleReadModel = {
  readonly articleId: string;
  readonly attributedTo: string;
  readonly title: string;
  readonly summaryHtml: string;
  readonly originalUrl: string;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date | null;
};

/** Remote Article resolver for inbound Create/Announce dereferencing. */
export type RemoteArticleResolver = {
  resolve(articleUrl: string): Promise<RemoteArticleReadModel>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includesArticleType(typeValue: unknown): boolean {
  if (typeValue === 'Article') {
    return true;
  }
  if (Array.isArray(typeValue)) {
    return typeValue.some((entry) => entry === 'Article');
  }
  return false;
}

/** Asserts a dereferenced JSON-LD document is explicitly typed as Article before Fedify parsing. */
export function assertRemoteArticleDocumentType(
  document: unknown,
): asserts document is Record<string, unknown> {
  if (!isRecord(document)) {
    throw new Error('Remote document is not a JSON object');
  }
  if (!includesArticleType(document.type)) {
    throw new Error('Remote document is not an Article');
  }
}

/**
 * Validates raw Article JSON-LD `@context` before Fedify parsing.
 *
 * Permits absent context, the ActivityStreams context URL preloaded by Fedify, and inline
 * term mappings without remote `@import`. Rejects unknown context URLs at the root or in
 * nested scoped `@context` values, and nested imports so `Article.fromJsonLd` cannot trigger
 * a second unbounded document-loader fetch.
 */
export function assertRemoteArticleJsonLdContext(document: Record<string, unknown>): void {
  const context = document['@context'];
  if (context === undefined || context === null) {
    return;
  }
  assertRemoteArticleContextValue(context);
}

function assertRemoteArticleContextValue(context: unknown): void {
  for (const entry of normalizeRemoteArticleContextEntries(context)) {
    if (typeof entry === 'string') {
      if (!ALLOWED_REMOTE_ARTICLE_CONTEXT_URLS.has(entry)) {
        throw new Error('Remote Article @context URL is not permitted');
      }
      continue;
    }
    if (isRecord(entry)) {
      assertRemoteArticleInlineContextObject(entry);
      continue;
    }
    throw new Error('Remote Article @context entry is not permitted');
  }
}

function normalizeRemoteArticleContextEntries(context: unknown): unknown[] {
  if (Array.isArray(context)) {
    return context;
  }
  if (typeof context === 'string' || isRecord(context)) {
    return [context];
  }
  throw new Error('Remote Article @context is not permitted');
}

function assertRemoteArticleInlineContextObject(context: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(context)) {
    if (key === '@import') {
      throw new Error('Remote Article @context @import is not permitted');
    }
    if (key === '@context') {
      assertRemoteArticleContextValue(value);
      continue;
    }
    if (isRecord(value)) {
      assertRemoteArticleInlineContextObject(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isRecord(item)) {
          assertRemoteArticleInlineContextObject(item);
        }
      }
    }
  }
}

function hasPublicAddressing(to: unknown): boolean {
  const values = Array.isArray(to) ? to : to ? [to] : [];
  return values.some((entry) => {
    if (typeof entry === 'string') {
      return entry === PUBLIC;
    }
    if (isRecord(entry) && 'id' in entry) {
      const id = entry.id;
      return typeof id === 'string' && id === PUBLIC;
    }
    return false;
  });
}

function readHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return assertInboundReportHttpsUrl(value, label);
}

function readOptionalInstant(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Temporal.Instant) {
    return new Date(value.epochMilliseconds);
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function readTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    const first = Object.values(value).find((entry) => typeof entry === 'string');
    if (typeof first === 'string') {
      return first;
    }
  }
  return '';
}

function readSummaryHtmlFromRecord(document: Record<string, unknown>): string {
  const content = document.content;
  if (typeof content === 'string' && content.length > 0) {
    return assertInboundReportRawSummary(content);
  }
  const summary = document.summary;
  if (typeof summary === 'string') {
    return assertInboundReportRawSummary(summary);
  }
  return '';
}

function readOriginalUrlFromRecord(document: Record<string, unknown>, articleId: string): string {
  const url = document.url;
  if (typeof url === 'string' && url.length > 0) {
    return assertInboundReportHttpsUrl(url, 'Article url');
  }
  return articleId;
}

function assertCoherentArticleOrigins(input: {
  articleId: string;
  attributedTo: string;
  originalUrl: string;
}): void {
  const articleOrigin = new URL(input.articleId).origin;
  const attributedOrigin = new URL(input.attributedTo).origin;
  const originalOrigin = new URL(input.originalUrl).origin;
  if (articleOrigin !== attributedOrigin || articleOrigin !== originalOrigin) {
    throw new Error('Article origins are not coherent');
  }
}

function validateArticleUrls(input: {
  articleId: string;
  attributedTo: string;
  originalUrl: string;
  isDomainBlocked: BlockedDomainPredicate;
}): void {
  assertInboundReportUrlAllowed(input.articleId, 'Article id', input.isDomainBlocked);
  assertInboundReportUrlAllowed(input.attributedTo, 'Article attributedTo', input.isDomainBlocked);
  assertInboundReportUrlAllowed(input.originalUrl, 'Article url', input.isDomainBlocked);
}

async function parseArticleDocument(
  document: Record<string, unknown>,
  finalUrl: string,
  isDomainBlocked: BlockedDomainPredicate,
): Promise<RemoteArticleReadModel> {
  assertRemoteArticleDocumentType(document);
  assertRemoteArticleJsonLdContext(document);
  const loader = createProductionSafeDocumentLoader();
  const article = await Article.fromJsonLd(document, { documentLoader: loader });
  if (!(article instanceof Article)) {
    throw new Error('Remote document is not an Article');
  }
  const articleId = readHttpsUrl(article.id?.href ?? null, 'Article id');
  if (new URL(articleId).toString() !== new URL(finalUrl).toString()) {
    throw new Error('Article id does not match resolved URL');
  }
  if (!hasPublicAddressing(document.to)) {
    throw new Error('Article must be addressed to Public');
  }
  const attributedTo = article.attributionId;
  if (!attributedTo) {
    throw new Error('Article attributedTo is required');
  }
  const attributedToUri = readHttpsUrl(attributedTo.href, 'Article attributedTo');
  const title = assertInboundReportTitle(readTextValue(document.name ?? article.name));
  const summaryHtml = sanitizeInboundReportSummaryHtml(readSummaryHtmlFromRecord(document));
  const originalUrl = readOriginalUrlFromRecord(document, articleId);
  assertCoherentArticleOrigins({ articleId, attributedTo: attributedToUri, originalUrl });
  validateArticleUrls({ articleId, attributedTo: attributedToUri, originalUrl, isDomainBlocked });
  return {
    articleId,
    attributedTo: attributedToUri,
    title,
    summaryHtml,
    originalUrl,
    publishedAt: readOptionalInstant(article.published),
    updatedAt: readOptionalInstant(article.updated),
  };
}

/** Creates a remote Article resolver using the bounded JSON fetch boundary. */
export function createRemoteArticleResolver(
  input: CreateBoundedRemoteJsonFetcherInput,
): RemoteArticleResolver {
  const fetcher = createBoundedRemoteJsonFetcher(input);
  return {
    async resolve(articleUrl: string) {
      const normalizedUrl = assertInboundReportHttpsUrl(articleUrl, 'Article URL');
      const { document, finalUrl } = await fetcher.fetchJsonDocument(normalizedUrl);
      return parseArticleDocument(document, finalUrl, input.isDomainBlocked);
    },
  };
}

/** Test-only Article resolver that bypasses network fetch. */
export function createTestRemoteArticleResolver(
  resolveImpl: (articleUrl: string) => Promise<RemoteArticleReadModel>,
): RemoteArticleResolver {
  return { resolve: resolveImpl };
}

/** Parses an embedded Article from a Create activity object for validation. */
export async function parseEmbeddedCreateArticle(input: {
  object: Record<string, unknown>;
  createActorUri: string;
  isDomainBlocked: BlockedDomainPredicate;
}): Promise<RemoteArticleReadModel> {
  assertRemoteArticleDocumentType(input.object);
  assertRemoteArticleJsonLdContext(input.object);
  const loader = createProductionSafeDocumentLoader();
  const article = await Article.fromJsonLd(input.object, { documentLoader: loader });
  if (!(article instanceof Article)) {
    throw new Error('Create object is not an Article');
  }
  const articleId = readHttpsUrl(article.id?.href ?? null, 'Article id');
  const attributedTo = article.attributionId;
  if (!attributedTo) {
    throw new Error('Article attributedTo is required');
  }
  const attributedToUri = readHttpsUrl(attributedTo.href, 'Article attributedTo');
  if (attributedToUri !== assertInboundReportHttpsUrl(input.createActorUri, 'Create actor')) {
    throw new Error('Article attributedTo must match Create actor');
  }
  if (!hasPublicAddressing(input.object.to)) {
    throw new Error('Article must be addressed to Public');
  }
  const title = assertInboundReportTitle(readTextValue(input.object.name));
  const summaryHtml = sanitizeInboundReportSummaryHtml(readSummaryHtmlFromRecord(input.object));
  const originalUrl = readOriginalUrlFromRecord(input.object, articleId);
  assertCoherentArticleOrigins({ articleId, attributedTo: attributedToUri, originalUrl });
  validateArticleUrls({
    articleId,
    attributedTo: attributedToUri,
    originalUrl,
    isDomainBlocked: input.isDomainBlocked,
  });
  return {
    articleId,
    attributedTo: attributedToUri,
    title,
    summaryHtml,
    originalUrl,
    publishedAt: readOptionalInstant(article.published),
    updatedAt: readOptionalInstant(article.updated),
  };
}

export { PUBLIC as ACTIVITYSTREAMS_PUBLIC_URI };
