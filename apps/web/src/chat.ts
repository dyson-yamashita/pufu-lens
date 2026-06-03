import { createHash } from 'node:crypto';
import type postgres from 'postgres';

export type ChatToolName =
  | 'document-fetch'
  | 'graph-query'
  | 'parsed-doc-fetch'
  | 'raw-document-fetch'
  | 'vector-search';

export interface ChatSource {
  readonly canonicalUri: string;
  readonly documentId: string;
  readonly docType: string;
  readonly rawDocumentId: string;
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
    throw new Error(`Project access denied: ${request.projectSlug}`);
  }

  const embedding = deterministicVector(request.question, 1536);
  const vectorSources = await options.repository.vectorSearch({
    embedding,
    limit: 5,
    projectId: project.id,
    query: request.question,
  });
  const graphSources = await options.repository.graphQuery({
    limit: 5,
    projectId: project.id,
    query: request.question,
  });
  const documentSources = await options.repository.documentFetch({
    documentIds: vectorSources.map((source) => source.documentId),
    projectId: project.id,
  });
  const rawSources = await options.repository.rawDocumentFetch({
    limit: 5,
    maxBytes: 64 * 1024,
    projectId: project.id,
  });
  const parsedSources = await options.repository.parsedDocFetch({
    limit: 5,
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
        throw new Error(`Gemini chat request failed: HTTP ${response.status}`);
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

export function createMemoryRateLimiter(input: {
  readonly limit: number;
  readonly windowMs: number;
}): ChatRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    check({ projectSlug, userId }) {
      const key = `${userId}:${projectSlug}`;
      const now = Date.now();
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

export function isWithinBusinessHours(date: Date, config: BusinessHoursConfig): boolean {
  if (!config.enabled) {
    return true;
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: config.timeZone,
    weekday: 'short',
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number.parseInt(parts.find((part) => part.type === 'hour')?.value ?? '0', 10);
  return (
    weekday !== 'Sat' && weekday !== 'Sun' && hour >= config.startHour && hour < config.endHour
  );
}

export function createPostgresChatRepository(sql: postgres.Sql): ChatRepository {
  return {
    async lookupProjectMember({ projectSlug, userId }) {
      const rows = (await sql`
        SELECT p.id::text AS id, p.slug
        FROM public.projects p
        JOIN public.project_members pm ON pm.project_id = p.id
        WHERE p.slug = ${projectSlug}
          AND pm.user_id = ${userId}
      `) as Array<{ id: string; slug: string }>;
      return rows[0];
    },
    async vectorSearch({ embedding, limit, projectId }) {
      const vector = `[${embedding.join(',')}]`;
      const rows = (await sql`
        SELECT DISTINCT ON (d.id)
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, '') AS canonical_uri
        FROM public.document_chunks dc
        JOIN public.documents d ON d.id = dc.document_id
        WHERE dc.project_id = ${projectId}
        ORDER BY d.id, dc.embedding <=> ${vector}::vector
        LIMIT ${limit}
      `) as ChatSourceRow[];
      return rows.map(sourceFromRow);
    },
    async graphQuery({ limit, projectId, query }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, '') AS canonical_uri
        FROM public.documents d
        WHERE d.project_id = ${projectId}
          AND (
            d.title ILIKE ${`%${query}%`}
            OR d.summary ILIKE ${`%${query}%`}
          )
        ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
        LIMIT ${limit}
      `) as ChatSourceRow[];
      return rows.map(sourceFromRow);
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
          coalesce(d.canonical_uri, '') AS canonical_uri
        FROM public.documents d
        WHERE d.project_id = ${projectId}
          AND d.id IN ${sql(documentIds)}
        ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
      `) as ChatSourceRow[];
      return rows.map(sourceFromRow);
    },
    async rawDocumentFetch({ limit, maxBytes, projectId }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, rd.source_uri, '') AS canonical_uri
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        WHERE d.project_id = ${projectId}
          AND coalesce(rd.byte_size, 0) <= ${maxBytes}
        ORDER BY rd.fetched_at DESC
        LIMIT ${limit}
      `) as ChatSourceRow[];
      return rows.map(sourceFromRow);
    },
    async parsedDocFetch({ limit, projectId }) {
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, rd.parsed_uri, '') AS canonical_uri
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        WHERE d.project_id = ${projectId}
          AND rd.parsed_uri IS NOT NULL
        ORDER BY rd.parsed_at DESC NULLS LAST
        LIMIT ${limit}
      `) as ChatSourceRow[];
      return rows.map(sourceFromRow);
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

interface ChatSourceRow {
  readonly canonical_uri: string;
  readonly document_id: string;
  readonly doc_type: string;
  readonly raw_document_id: string;
  readonly title: string;
}

function sourceFromRow(row: ChatSourceRow): ChatSource {
  return {
    canonicalUri: row.canonical_uri,
    documentId: row.document_id,
    docType: row.doc_type,
    rawDocumentId: row.raw_document_id,
    title: row.title,
  };
}

function deterministicVector(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    const digest = createHash('sha256').update(`${index}:${text}`).digest();
    const value = digest.readUInt32BE(0) / 0xffffffff;
    vector.push(value * 2 - 1);
  }
  return vector;
}
