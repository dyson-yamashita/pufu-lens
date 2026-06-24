import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { lookupProjectMemberAccess } from './authz.ts';
import {
  type AgentRawReadViewEnvelope,
  createPostgresRawReadViewRepository,
  type RawReadViewRequest,
} from './raw-read-view.ts';
import type { PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';

export type ChatToolName =
  | 'document-fetch'
  | 'graph-query'
  | 'parsed-doc-fetch'
  | 'raw-document-fetch'
  | 'vector-search';

export type PublicChatToolName = 'public-context-fetch' | 'public-report-fetch';

export interface ChatSource {
  readonly canonicalUri: string;
  readonly documentId: string;
  readonly docType: string;
  readonly rawDocumentId: string;
  readonly snippet?: string;
  readonly title: string;
}

export interface ChatToolCall {
  readonly name: ChatToolName;
  readonly resultCount: number;
}

export interface ChatResponse {
  readonly answer: string;
  readonly projectSlug: string;
  readonly sources: readonly ChatSource[];
  readonly status: 'answered' | 'db_outside_business_hours' | 'rate_limited';
  readonly toolCalls: readonly ChatToolCall[];
}

export interface PublicChatSource {
  readonly label: string;
  readonly publicSourceId: string;
  readonly sectionId: string;
}

export interface PublicChatToolCall {
  readonly name: PublicChatToolName;
  readonly resultCount: number;
}

export interface PublicChatResponse {
  readonly answer: string;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly sources: readonly PublicChatSource[];
  readonly status: 'answered' | 'no_public_report' | 'rate_limited' | 'refused';
  readonly toolCalls: readonly PublicChatToolCall[];
}

export class ProjectAccessDeniedError extends Error {
  readonly projectSlug: string;

  constructor(projectSlug: string) {
    super(`Project access denied: ${projectSlug}`);
    this.name = 'ProjectAccessDeniedError';
    this.projectSlug = projectSlug;
  }
}

export interface ChatRequest {
  readonly now?: Date;
  readonly projectSlug: string;
  readonly question: string;
  readonly userId: string;
}

export interface ChatRepository {
  documentFetch(input: {
    documentIds: readonly string[];
    projectId: string;
  }): Promise<ChatSource[]>;
  graphQuery(input: { limit: number; projectId: string; query: string }): Promise<ChatSource[]>;
  lookupProjectMember(input: {
    projectSlug: string;
    userId: string;
  }): Promise<{ readonly id: string; readonly slug: string } | undefined>;
  parsedDocFetch(input: { limit: number; projectId: string }): Promise<ChatSource[]>;
  rawDocumentFetch(input: {
    limit: number;
    maxBytes: number;
    projectId: string;
  }): Promise<ChatSource[]>;
  rawReadViewFetch(input: RawReadViewRequest): Promise<AgentRawReadViewEnvelope | undefined>;
  vectorSearch(input: {
    embedding: readonly number[];
    limit: number;
    projectId: string;
    query: string;
  }): Promise<ChatSource[]>;
}

export interface ChatProvider {
  complete(input: { question: string; sources: readonly ChatSource[] }): Promise<string>;
}

export interface RunPrivateChatOptions {
  readonly businessHours?: BusinessHoursConfig;
  readonly provider: ChatProvider;
  readonly rateLimiter?: ChatRateLimiter;
  readonly repository: ChatRepository;
}

export interface BusinessHoursConfig {
  readonly enabled: boolean;
  readonly endHour: number;
  readonly startHour: number;
  readonly timeZone: string;
}

export interface ChatRateLimiter {
  check(input: { projectSlug: string; userId: string }): boolean;
}

export interface PublicChatRateLimiter {
  check(input: { clientIp: string; reportId: string }): boolean;
}

export interface PublicChatProvider {
  complete(input: {
    readonly contextBundle: PublicContextBundleV1;
    readonly projectSlug: string;
    readonly question: string;
    readonly report: PublicReportJsonV1;
    readonly sources: readonly PublicChatSource[];
  }): Promise<string>;
}

export function graphQuerySearchPatterns(query: string): string[] {
  const normalized = normalizeSpaces(query);
  const withoutRequestSuffix = stripGraphQueryRequestSuffix(normalized);
  const candidates = [
    normalized,
    stripAfterGraphQuery(stripAfterGraphQuery(normalized, 'グラフクエリ'), 'graph query'),
    stripAfterAny(normalized, ['について', 'に関する']),
    stripAfterGraphQuery(stripAfterGraphQuery(withoutRequestSuffix, 'グラフクエリ'), 'graph query'),
    stripAfterAny(withoutRequestSuffix, ['について', 'に関する']),
  ]
    .map((candidate) => stripGraphQueryPrefix(candidate).trim())
    .filter((candidate) => candidate.length > 0);
  return [...new Set(candidates)].slice(0, 5).map((candidate) => `%${candidate}%`);
}

function normalizeSpaces(value: string): string {
  let output = '';
  let pendingSpace = false;
  for (const char of value.trim()) {
    if (char.trim() === '') {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output.length > 0) {
      output += ' ';
    }
    output += char;
    pendingSpace = false;
  }
  return output;
}

function stripGraphQueryRequestSuffix(value: string): string {
  let output = value.endsWith('。') ? value.slice(0, -1) : value;
  const suffixGroups = [
    ['知りたいです', '知りたい', 'ください', '教えて'],
    ['を'],
    ['結果', '情報'],
    ['について', 'に関する', 'を', 'の'],
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffixes of suffixGroups) {
      for (const suffix of suffixes) {
        if (output.endsWith(suffix)) {
          output = output.slice(0, -suffix.length).trim();
          changed = true;
          break;
        }
      }
      if (changed) {
        break;
      }
    }
  }
  return output.trim();
}

function stripAfterAny(value: string, markers: readonly string[]): string {
  const indexes = markers.map((marker) => value.indexOf(marker)).filter((index) => index >= 0);
  return indexes.length === 0 ? value : value.slice(0, Math.min(...indexes)).trim();
}

function stripAfterGraphQuery(value: string, marker: string): string {
  const lowerValue = value.toLowerCase();
  const index = lowerValue.indexOf(marker.toLowerCase());
  if (index < 0) {
    return value;
  }
  const endIndex = marker === 'グラフクエリ' && value[index - 1] === 'の' ? index - 1 : index;
  return value.slice(0, endIndex).trim();
}

function stripGraphQueryPrefix(value: string): string {
  let output = value;
  for (const prefix of ['現在の', '最新の', '現在', '最新', 'の']) {
    if (output.startsWith(prefix)) {
      output = output.slice(prefix.length);
      break;
    }
  }
  return output;
}

export interface RunPublicChatOptions {
  readonly contextBundle: PublicContextBundleV1;
  readonly provider: PublicChatProvider;
  readonly rateLimiters?: readonly PublicChatRateLimiter[];
  readonly report: PublicReportJsonV1;
}

const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  enabled: false,
  endHour: 18,
  startHour: 9,
  timeZone: 'Asia/Tokyo',
};

export async function runPrivateChat(
  request: ChatRequest,
  options: RunPrivateChatOptions,
): Promise<ChatResponse> {
  const businessHours = options.businessHours ?? DEFAULT_BUSINESS_HOURS;
  if (!isWithinBusinessHours(request.now ?? new Date(), businessHours)) {
    return unavailableResponse(request.projectSlug);
  }
  if (options.rateLimiter && !options.rateLimiter.check(request)) {
    return {
      answer: 'rate limit exceeded',
      projectSlug: request.projectSlug,
      sources: [],
      status: 'rate_limited',
      toolCalls: [],
    };
  }

  const project = await options.repository.lookupProjectMember({
    projectSlug: request.projectSlug,
    userId: request.userId,
  });
  if (!project) {
    throw new ProjectAccessDeniedError(request.projectSlug);
  }

  const embedding = deterministicVector(request.question, 1536);
  const [vectorSources, graphSources, rawSources, parsedSources] = await Promise.all([
    options.repository.vectorSearch({
      embedding,
      limit: 5,
      projectId: project.id,
      query: request.question,
    }),
    options.repository.graphQuery({
      limit: 5,
      projectId: project.id,
      query: request.question,
    }),
    options.repository.rawDocumentFetch({
      limit: 5,
      maxBytes: 64 * 1024,
      projectId: project.id,
    }),
    options.repository.parsedDocFetch({
      limit: 5,
      projectId: project.id,
    }),
  ]);
  const documentSources = await options.repository.documentFetch({
    documentIds: vectorSources.map((source) => source.documentId),
    projectId: project.id,
  });
  const sources = uniqueSources([
    ...vectorSources,
    ...graphSources,
    ...documentSources,
    ...rawSources,
    ...parsedSources,
  ]).slice(0, 5);

  return {
    answer: await options.provider.complete({ question: request.question, sources }),
    projectSlug: request.projectSlug,
    sources,
    status: 'answered',
    toolCalls: [
      { name: 'vector-search', resultCount: vectorSources.length },
      { name: 'graph-query', resultCount: graphSources.length },
      { name: 'document-fetch', resultCount: documentSources.length },
      { name: 'raw-document-fetch', resultCount: rawSources.length },
      { name: 'parsed-doc-fetch', resultCount: parsedSources.length },
    ],
  };
}

export async function runPublicChat(
  request: {
    readonly clientIp: string;
    readonly projectSlug: string;
    readonly question: string;
    readonly reportId: string;
  },
  options: RunPublicChatOptions,
): Promise<PublicChatResponse> {
  for (const rateLimiter of options.rateLimiters ?? []) {
    if (!rateLimiter.check({ clientIp: request.clientIp, reportId: request.reportId })) {
      return publicChatResponse({
        answer: 'rate limit exceeded',
        projectSlug: request.projectSlug,
        reportId: request.reportId,
        status: 'rate_limited',
      });
    }
  }

  const sources = publicChatSources(options.report, options.contextBundle);
  const toolCalls: PublicChatToolCall[] = [
    { name: 'public-report-fetch', resultCount: 1 },
    { name: 'public-context-fetch', resultCount: options.contextBundle.sections.length },
  ];
  if (shouldRefusePublicQuestion(request.question)) {
    return publicChatResponse({
      answer:
        '公開レポートの範囲外、または未公開情報の要求には回答できません。公開済み section id / public source id に基づく質問をしてください。',
      projectSlug: request.projectSlug,
      reportId: request.reportId,
      sources: [],
      status: 'refused',
      toolCalls,
    });
  }

  return publicChatResponse({
    answer: await options.provider.complete({
      contextBundle: options.contextBundle,
      projectSlug: request.projectSlug,
      question: request.question,
      report: options.report,
      sources,
    }),
    projectSlug: request.projectSlug,
    reportId: request.reportId,
    sources,
    status: 'answered',
    toolCalls,
  });
}

export function createGeminiChatProvider(input: {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly model: string;
}): ChatProvider {
  if (!input.apiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini chat.');
  }
  if (!input.model) {
    throw new Error('GEMINI_CHAT_MODEL is required for Gemini chat.');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint =
    input.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`;
  return {
    async complete({ question, sources }) {
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(input.apiKey)}`, {
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    'Answer using only the provided project sources.',
                    `Question: ${question}`,
                    `Sources: ${JSON.stringify(sources)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(
          `Gemini chat request failed: HTTP ${response.status}${await geminiErrorDetails(
            response,
          )}`,
        );
      }
      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
      if (!text) {
        throw new Error('Gemini chat response did not include text.');
      }
      return text;
    },
  };
}

export function createExtractiveChatProvider(): ChatProvider {
  return {
    async complete({ question, sources }) {
      const sourceText = sources
        .map((source) => `${source.title} (${source.canonicalUri || source.documentId})`)
        .join(', ');
      return sourceText
        ? `質問「${question}」に関連する source は ${sourceText} です。`
        : `質問「${question}」に関連する source は見つかりませんでした。`;
    },
  };
}

export function createExtractivePublicChatProvider(): PublicChatProvider {
  return {
    async complete({ contextBundle, question, report, sources }) {
      const sourceText = sources
        .map((source) => `${source.publicSourceId} (${source.sectionId})`)
        .join(', ');
      const sectionText = contextBundle.sections
        .map((section) => `${section.id}: ${section.markdown}`)
        .join('\n');
      return [
        `質問「${question}」への回答です。`,
        `公開レポート ${report.report_id} の section id: ${contextBundle.sections
          .map((section) => section.id)
          .join(', ')}。`,
        sourceText
          ? `根拠 public source id: ${sourceText}。`
          : '根拠 public source id はありません。',
        `公開 context: ${sectionText}`,
      ].join('\n');
    },
  };
}

export function createGeminiPublicChatProvider(input: {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly model: string;
}): PublicChatProvider {
  if (!input.apiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini public chat.');
  }
  if (!input.model) {
    throw new Error('GEMINI_CHAT_MODEL is required for Gemini public chat.');
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint =
    input.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`;
  return {
    async complete({ contextBundle, projectSlug, question, report, sources }) {
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(input.apiKey)}`, {
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    'Answer only from this redacted public report and public context bundle.',
                    'Do not reveal email addresses, private URLs, raw or parsed content, secrets, projectId, storageUri, or documentId.',
                    'If the question asks for information outside the public report, refuse briefly.',
                    'Cite section id or public source id in the answer.',
                    `Project slug: ${projectSlug}`,
                    `Question: ${question}`,
                    `Public report: ${JSON.stringify(report)}`,
                    `Public context bundle: ${JSON.stringify(contextBundle)}`,
                    `Allowed sources: ${JSON.stringify(sources)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(
          `Gemini public chat request failed: HTTP ${response.status}${await geminiErrorDetails(
            response,
          )}`,
        );
      }
      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
      if (!text) {
        throw new Error('Gemini public chat response did not include text.');
      }
      return text;
    },
  };
}

export function createMemoryRateLimiter(input: {
  readonly cleanupThreshold?: number;
  readonly limit: number;
  readonly now?: () => number;
  readonly windowMs: number;
}): ChatRateLimiter {
  const cleanupThreshold = input.cleanupThreshold ?? 1000;
  const nowProvider = input.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    check({ projectSlug, userId }) {
      const key = `${userId}:${projectSlug}`;
      const now = nowProvider();
      if (buckets.size > cleanupThreshold) {
        cleanupExpiredBuckets(buckets, now);
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + input.windowMs });
        return true;
      }
      if (bucket.count >= input.limit) {
        return false;
      }
      bucket.count += 1;
      return true;
    },
  };
}

export function createPublicChatMemoryRateLimiter(input: {
  readonly cleanupIntervalMs?: number;
  readonly cleanupThreshold?: number;
  readonly limit: number;
  readonly now?: () => number;
  readonly windowMs: number;
}): PublicChatRateLimiter {
  const cleanupIntervalMs = input.cleanupIntervalMs ?? 60_000;
  const cleanupThreshold = input.cleanupThreshold ?? 1000;
  const nowProvider = input.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastCleanup = nowProvider();
  return {
    check({ clientIp, reportId }) {
      const key = `${clientIp}:${reportId}`;
      const now = nowProvider();
      if (buckets.size > cleanupThreshold && now - lastCleanup >= cleanupIntervalMs) {
        cleanupExpiredBuckets(buckets, now);
        lastCleanup = now;
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + input.windowMs });
        return true;
      }
      if (bucket.count >= input.limit) {
        return false;
      }
      bucket.count += 1;
      return true;
    },
  };
}

export function businessHoursFromEnv(env: NodeJS.ProcessEnv): BusinessHoursConfig {
  return {
    enabled: env.PUFU_LENS_CHAT_ENFORCE_BUSINESS_HOURS === 'true',
    endHour: Number.parseInt(env.PUFU_LENS_BUSINESS_END_HOUR ?? '18', 10),
    startHour: Number.parseInt(env.PUFU_LENS_BUSINESS_START_HOUR ?? '9', 10),
    timeZone: env.PUFU_LENS_BUSINESS_TIME_ZONE ?? 'Asia/Tokyo',
  };
}

export function chatNowFromEnv(env?: NodeJS.ProcessEnv): Date | undefined {
  const value = env?.PUFU_LENS_CHAT_NOW?.trim();
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('PUFU_LENS_CHAT_NOW must be an ISO 8601 datetime.');
  }
  return date;
}

export function isWithinBusinessHours(date: Date, config: BusinessHoursConfig): boolean {
  if (!config.enabled) {
    return true;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: config.timeZone,
    weekday: 'short',
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number.parseInt(parts.find((part) => part.type === 'hour')?.value ?? '0', 10);
  return (
    weekday !== 'Sat' && weekday !== 'Sun' && hour >= config.startHour && hour < config.endHour
  );
}

export function createPostgresChatRepository(
  sql: postgres.Sql,
  options: { readonly rawStorage?: Pick<ObjectStorage, 'getText'> } = {},
): ChatRepository {
  const rawReadViewRepository = options.rawStorage
    ? createPostgresRawReadViewRepository({ sql, storage: options.rawStorage })
    : undefined;
  return {
    async lookupProjectMember({ projectSlug, userId }) {
      const access = await lookupProjectMemberAccess(sql, { projectSlug, userId });
      return access ? { id: access.id, slug: access.slug } : undefined;
    },
    async vectorSearch({ embedding, limit, projectId }) {
      const vector = `[${embedding.join(',')}]`;
      const rows = (await sql`
        WITH distinct_chunks AS (
          SELECT DISTINCT ON (d.id)
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            left(coalesce(dc.content, d.summary, ''), 700) AS snippet,
            dc.embedding <=> ${vector}::vector AS distance
          FROM public.document_chunks dc
          JOIN public.documents d ON d.id = dc.document_id
          WHERE dc.project_id = ${projectId}
          ORDER BY d.id, dc.embedding <=> ${vector}::vector
        )
        SELECT document_id, raw_document_id, doc_type, title, canonical_uri, snippet
        FROM distinct_chunks
        ORDER BY distance
        LIMIT ${limit}
      `) as readonly unknown[];
      return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
    },
    async graphQuery({ limit, projectId, query }) {
      const patterns = graphQuerySearchPatterns(query);
      const searchPatterns = patterns.length > 0 ? patterns : [`%${query}%`];
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, '') AS canonical_uri,
          left(coalesce(d.summary, dc.content, ''), 700) AS snippet
        FROM public.documents d
        LEFT JOIN LATERAL (
          SELECT content
          FROM public.document_chunks
          WHERE project_id = d.project_id
            AND document_id = d.id
          ORDER BY chunk_index ASC
          LIMIT 1
        ) dc ON true
        WHERE d.project_id = ${projectId}
          AND (
            d.title ILIKE ANY (${searchPatterns})
            OR d.summary ILIKE ANY (${searchPatterns})
          )
        ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
        LIMIT ${limit}
      `) as readonly unknown[];
      return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
    },
    async documentFetch({ documentIds, projectId }) {
      if (documentIds.length === 0) {
        return [];
      }
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, '') AS canonical_uri,
          left(coalesce(d.summary, dc.content, ''), 700) AS snippet
        FROM public.documents d
        LEFT JOIN LATERAL (
          SELECT content
          FROM public.document_chunks
          WHERE project_id = d.project_id
            AND document_id = d.id
          ORDER BY chunk_index ASC
          LIMIT 1
        ) dc ON true
        WHERE d.project_id = ${projectId}
          AND d.id IN ${sql(documentIds)}
        ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
      `) as readonly unknown[];
      return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
    },
    async rawDocumentFetch({ limit, maxBytes, projectId }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, rd.source_uri, '') AS canonical_uri,
          left(coalesce(d.summary, dc.content, ''), 700) AS snippet
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        LEFT JOIN LATERAL (
          SELECT content
          FROM public.document_chunks
          WHERE project_id = d.project_id
            AND document_id = d.id
          ORDER BY chunk_index ASC
          LIMIT 1
        ) dc ON true
        WHERE d.project_id = ${projectId}
          AND coalesce(rd.byte_size, 0) <= ${maxBytes}
        ORDER BY rd.fetched_at DESC
        LIMIT ${limit}
      `) as readonly unknown[];
      return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
    },
    async rawReadViewFetch(input) {
      return rawReadViewRepository?.fetchRawReadView(input);
    },
    async parsedDocFetch({ limit, projectId }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, rd.parsed_uri, '') AS canonical_uri,
          left(coalesce(d.summary, dc.content, ''), 700) AS snippet
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        LEFT JOIN LATERAL (
          SELECT content
          FROM public.document_chunks
          WHERE project_id = d.project_id
            AND document_id = d.id
          ORDER BY chunk_index ASC
          LIMIT 1
        ) dc ON true
        WHERE d.project_id = ${projectId}
          AND rd.parsed_uri IS NOT NULL
        ORDER BY rd.parsed_at DESC NULLS LAST
        LIMIT ${limit}
      `) as readonly unknown[];
      return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
    },
  };
}

function unavailableResponse(projectSlug: string): ChatResponse {
  return {
    answer: 'db_outside_business_hours',
    projectSlug,
    sources: [],
    status: 'db_outside_business_hours',
    toolCalls: [],
  };
}

function publicChatResponse(input: {
  readonly answer: string;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly sources?: readonly PublicChatSource[];
  readonly status: PublicChatResponse['status'];
  readonly toolCalls?: readonly PublicChatToolCall[];
}): PublicChatResponse {
  return {
    answer: input.answer,
    projectSlug: input.projectSlug,
    reportId: input.reportId,
    sources: input.sources ?? [],
    status: input.status,
    toolCalls: input.toolCalls ?? [],
  };
}

export function publicChatSources(
  report: PublicReportJsonV1,
  contextBundle: PublicContextBundleV1,
): PublicChatSource[] {
  const contextSourceIds = new Set(
    contextBundle.sections.flatMap((section) => section.public_source_ids),
  );
  return report.sections.flatMap((section) =>
    (section.sources ?? [])
      .filter((source) => contextSourceIds.has(source.public_source_id))
      .map((source) => ({
        label: source.label,
        publicSourceId: source.public_source_id,
        sectionId: section.id,
      })),
  );
}

export function shouldRefusePublicQuestion(question: string): boolean {
  return /raw|parsed|全文|元メール|メール本文|document[_\s-]?id|project[_\s-]?id|storage[_\s-]?uri|source[_\s-]?uri|別プロジェクト|他プロジェクト|未公開|社内|private|secret|oauth/i.test(
    question,
  );
}

function uniqueSources(sources: readonly ChatSource[]): ChatSource[] {
  const seen = new Set<string>();
  const unique: ChatSource[] = [];
  for (const source of sources) {
    if (!seen.has(source.documentId)) {
      seen.add(source.documentId);
      unique.push(source);
    }
  }
  return unique;
}

function cleanupExpiredBuckets(
  buckets: Map<string, { count: number; resetAt: number }>,
  now: number,
): void {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export interface ChatSourceRow {
  readonly canonical_uri: string;
  readonly document_id: string;
  readonly doc_type: string;
  readonly raw_document_id: string;
  readonly snippet?: string | null;
  readonly title: string;
}

export function parseChatSourceRow(value: unknown): ChatSourceRow {
  if (!isRecord(value)) {
    throw new Error('Invalid chat source row.');
  }
  const { canonical_uri, document_id, doc_type, raw_document_id, snippet, title } = value;
  return {
    canonical_uri: parseRequiredString(canonical_uri, 'canonical_uri'),
    document_id: parseRequiredString(document_id, 'document_id'),
    doc_type: parseRequiredString(doc_type, 'doc_type'),
    raw_document_id: parseRequiredString(raw_document_id, 'raw_document_id'),
    snippet: parseOptionalNullableString(snippet, 'snippet'),
    title: parseRequiredString(title, 'title'),
  };
}

function sourceFromRow(row: ChatSourceRow): ChatSource {
  return {
    canonicalUri: row.canonical_uri,
    documentId: row.document_id,
    docType: row.doc_type,
    rawDocumentId: row.raw_document_id,
    snippet: row.snippet?.trim() || undefined,
    title: row.title,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid chat source row field: ${fieldName}`);
}

function parseOptionalNullableString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined || value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid chat source row field: ${fieldName}`);
}

function deterministicVector(text: string, dimensions: number): number[] {
  const hash = createHash('sha256').update(text).digest();
  let seed = hash.readUInt32BE(0);
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    seed = (seed * 1664525 + 1013904223) | 0;
    const value = (seed >>> 0) / 0xffffffff;
    vector.push(value * 2 - 1);
  }
  return vector;
}

async function geminiErrorDetails(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    return '';
  }
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? `: ${body.error.message}` : '';
  } catch {
    return '';
  }
}
