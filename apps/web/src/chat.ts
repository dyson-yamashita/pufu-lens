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

export type ChatGraphRelationType = 'MENTIONS' | 'RELATED_TO' | 'SAME_AS';

export type ChatGraphRelatedSource = ChatSource & {
  readonly hopCount: 1 | 2;
  readonly relationType: ChatGraphRelationType;
  readonly seedDocumentId: string;
};

export interface ChatToolCall {
  readonly name: ChatToolName;
  readonly resultCount: number;
}

export type ChatEditingMode =
  | 'default'
  | 'issue_mapping'
  | 'next_actions'
  | 'risk_scan'
  | 'structure'
  | 'summary'
  | 'timeline';

export type ChatEditingQuestionType =
  | 'fact'
  | 'planning'
  | 'public_explanation'
  | 'risk'
  | 'status'
  | 'timeline'
  | 'unknown';

export interface ChatEditingMetadata {
  readonly caveats: readonly string[];
  readonly confidence: 'high' | 'low' | 'medium';
  readonly inferredMode: ChatEditingMode;
  readonly operations: readonly string[];
  readonly questionType: ChatEditingQuestionType;
}

export interface ChatResponse {
  readonly answer: string;
  readonly editing?: ChatEditingMetadata;
  readonly projectSlug: string;
  readonly sources: readonly ChatSource[];
  readonly status: 'answered' | 'db_outside_business_hours' | 'rate_limited';
  readonly toolCalls: readonly ChatToolCall[];
}

export interface PrivateChatHistoryItem {
  readonly answer: string;
  readonly createdAt: string;
  readonly editing?: ChatEditingMetadata;
  readonly id: string;
  readonly question: string;
  readonly sources: readonly ChatSource[];
  readonly toolCalls: readonly ChatToolCall[];
}

export interface PrivateChatHistoryListResponse {
  readonly items: readonly PrivateChatHistoryItem[];
}

export interface MastraChatHistoryMessage {
  readonly content: string;
  readonly role: 'assistant' | 'user';
}

export const PRIVATE_CHAT_CONTEXT_TURN_LIMIT = 6;
export const PRIVATE_CHAT_HISTORY_UI_LIMIT = 50;
export const PRIVATE_CHAT_HISTORY_CONTENT_MAX = 4000;

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
  readonly editing?: ChatEditingMetadata;
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
  graphQuery(input: {
    graphName?: string | null;
    limit: number;
    projectId: string;
    query: string;
    seedDocumentIds?: readonly string[];
  }): Promise<ChatSource[]>;
  lookupProjectMember(input: {
    projectSlug: string;
    userId: string;
  }): Promise<
    { readonly graphName: string | null; readonly id: string; readonly slug: string } | undefined
  >;
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
  listPrivateChatHistoryForContext(input: {
    limit?: number;
    projectId: string;
    userId: string;
  }): Promise<readonly PrivateChatHistoryItem[]>;
  listPrivateChatHistoryForUi(input: {
    limit?: number;
    projectId: string;
    userId: string;
  }): Promise<readonly PrivateChatHistoryItem[]>;
  savePrivateChatTurn(input: {
    answer: string;
    editing?: ChatEditingMetadata;
    projectId: string;
    question: string;
    sources: readonly ChatSource[];
    toolCalls: readonly ChatToolCall[];
    userId: string;
  }): Promise<PrivateChatHistoryItem>;
}

export interface ChatProvider {
  complete(input: {
    editing: ChatEditingMetadata;
    question: string;
    sources: readonly ChatSource[];
  }): Promise<string>;
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
    readonly editing: ChatEditingMetadata;
    readonly projectSlug: string;
    readonly question: string;
    readonly report: PublicReportJsonV1;
    readonly sources: readonly PublicChatSource[];
  }): Promise<string>;
}

const EDITING_MODE_DEFINITIONS: Record<
  ChatEditingMode,
  {
    readonly caveats: readonly string[];
    readonly keywords: readonly string[];
    readonly operations: readonly string[];
    readonly questionType: ChatEditingQuestionType;
  }
> = {
  default: {
    caveats: ['質問意図を特定の編集方針に寄せず、通常の根拠確認を優先します。'],
    keywords: [],
    operations: ['収集', '選択', '引用'],
    questionType: 'unknown',
  },
  issue_mapping: {
    caveats: ['論点の分類は根拠 source の範囲に限定します。'],
    keywords: ['issue', '課題', '問題点', '論点', '未決', '争点', '整理して', '何が決まっていない'],
    operations: ['分類', '比較', '境界', '焦点化'],
    questionType: 'status',
  },
  next_actions: {
    caveats: ['推奨アクションは根拠と未確認事項を分けて扱います。'],
    keywords: [
      'next action',
      'todo',
      'action item',
      'アクション',
      'やること',
      '次に',
      'すべきこと',
      '確認すべき',
    ],
    operations: ['道筋', '脚本', '統御'],
    questionType: 'planning',
  },
  risk_scan: {
    caveats: ['リスク判断は複数 source の一致や未確認事項を優先して扱います。'],
    keywords: [
      'risk',
      'blocked',
      'blocker',
      'リスク',
      '懸念',
      '停滞',
      'ボトルネック',
      '危険',
      '詰ま',
    ],
    operations: ['競合', '推理', '構造', '生態'],
    questionType: 'risk',
  },
  structure: {
    caveats: ['構造化は source 間の関係を説明する補助であり、根拠の代替ではありません。'],
    keywords: ['map', 'structure', '構造', '全体像', '関係', '地図', '図解', 'つながり'],
    operations: ['地図', '図解', '構造', '模型'],
    questionType: 'status',
  },
  summary: {
    caveats: ['要約は根拠 source の内容を圧縮し、未確認情報を補いません。'],
    keywords: ['summary', 'summarize', '要約', 'まとめ', 'サマリ', '短く', '概要'],
    operations: ['要約', '凝縮', '引用'],
    questionType: 'fact',
  },
  timeline: {
    caveats: ['時系列は日付や actor hint が確認できる範囲に限定します。'],
    keywords: ['timeline', 'history', '経緯', 'いつ決ま', '時系列', '履歴', '流れ', 'なぜ判断'],
    operations: ['系統', '順番', '注釈', '場面'],
    questionType: 'timeline',
  },
};

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

export function shouldUseGraphRelatedSource(input: {
  candidate: ChatGraphRelatedSource;
  question: string;
  seedDocumentIds: readonly string[];
}): boolean {
  const { candidate, seedDocumentIds } = input;
  if (seedDocumentIds.includes(candidate.documentId)) {
    return false;
  }
  const validCombination =
    (candidate.relationType === 'SAME_AS' && candidate.hopCount === 1) ||
    (candidate.relationType === 'RELATED_TO' && candidate.hopCount === 1) ||
    (candidate.relationType === 'MENTIONS' && candidate.hopCount === 2);
  if (!validCombination) {
    return false;
  }
  const title = candidate.title.trim();
  const snippet = candidate.snippet?.trim() ?? '';
  return Boolean((title && title !== 'Untitled') || snippet);
}

export function inferChatEditingMetadata(question: string): ChatEditingMetadata {
  const normalized = normalizeSpaces(question).toLowerCase();
  const matches = (Object.keys(EDITING_MODE_DEFINITIONS) as ChatEditingMode[])
    .filter((mode) => mode !== 'default')
    .map((mode) => ({
      mode,
      score: EDITING_MODE_DEFINITIONS[mode].keywords.filter((keyword) =>
        matchesEditingKeyword(normalized, keyword),
      ).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  const best = matches[0];
  if (!best) {
    return editingMetadataFromMode('default', 'low');
  }
  return editingMetadataFromMode(best.mode, best.score >= 2 ? 'high' : 'medium');
}

function matchesEditingKeyword(normalizedQuestion: string, keyword: string): boolean {
  const normalizedKeyword = keyword.toLowerCase();
  if (/^[a-z0-9][a-z0-9 -]*$/i.test(normalizedKeyword)) {
    const escaped = normalizedKeyword
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedQuestion);
  }
  return normalizedQuestion.includes(normalizedKeyword);
}

export function inferPublicChatEditingMetadata(question: string): ChatEditingMetadata {
  const inferred = inferChatEditingMetadata(question);
  const publicCaveat = '公開レポートと public context bundle の範囲だけで回答します。';
  if (inferred.inferredMode === 'risk_scan') {
    return {
      ...editingMetadataFromMode('default', 'low'),
      caveats: [publicCaveat, '内部リスク分析や未公開資料の探索は行いません。'],
      operations: ['要約', '焦点化', '引用'],
      questionType: 'public_explanation',
    };
  }
  return {
    ...inferred,
    caveats: [...inferred.caveats, publicCaveat],
    questionType:
      inferred.questionType === 'unknown' ? 'public_explanation' : inferred.questionType,
  };
}

function editingMetadataFromMode(
  inferredMode: ChatEditingMode,
  confidence: ChatEditingMetadata['confidence'],
): ChatEditingMetadata {
  const definition = EDITING_MODE_DEFINITIONS[inferredMode];
  return {
    caveats: definition.caveats,
    confidence,
    inferredMode,
    operations: definition.operations,
    questionType: definition.questionType,
  };
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
const VECTOR_SEARCH_MIN_CANDIDATE_LIMIT = 50;
const VECTOR_SEARCH_MAX_CANDIDATE_LIMIT = 200;
const HYBRID_KEYWORD_QUERY_INPUT_MAX = 1024;
const HYBRID_KEYWORD_QUERY_OUTPUT_MAX = 512;

/**
 * Runs the private chat workflow for a project member.
 *
 * Returns an unavailable response outside business hours, a rate-limited response when the limiter rejects the request, or an answered response with retrieved sources and the generated answer.
 *
 * @param request - The private chat request
 * @param options - The chat runtime dependencies and policy settings
 * @returns The private chat response
 * @throws ProjectAccessDeniedError If the user does not have access to the project
 */
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

  const editing = inferChatEditingMetadata(request.question);
  const embedding = deterministicVector(request.question, 1536);
  const vectorSources = await options.repository.vectorSearch({
    embedding,
    limit: 5,
    projectId: project.id,
    query: request.question,
  });
  const [graphSources, rawSources, parsedSources] = await Promise.all([
    options.repository.graphQuery({
      graphName: project.graphName,
      limit: 5,
      projectId: project.id,
      query: request.question,
      seedDocumentIds: vectorSources.map((source) => source.documentId),
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
  const graphSourceBudget = Math.min(graphSources.length, 2);
  const vectorSourceBudget = 5 - graphSourceBudget;
  const sources = uniqueSources([
    ...vectorSources.slice(0, vectorSourceBudget),
    ...graphSources.slice(0, graphSourceBudget),
    ...vectorSources.slice(vectorSourceBudget),
    ...documentSources,
    ...rawSources,
    ...parsedSources,
  ]).slice(0, 5);

  return {
    answer: await options.provider.complete({ editing, question: request.question, sources }),
    editing,
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

  const editing = inferPublicChatEditingMetadata(request.question);
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
      editing,
      toolCalls,
    });
  }

  return publicChatResponse({
    answer: await options.provider.complete({
      contextBundle: options.contextBundle,
      editing,
      projectSlug: request.projectSlug,
      question: request.question,
      report: options.report,
      sources,
    }),
    projectSlug: request.projectSlug,
    reportId: request.reportId,
    sources,
    status: 'answered',
    editing,
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
    async complete({ editing, question, sources }) {
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(input.apiKey)}`, {
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: [
                    'Answer using only the provided project sources.',
                    'Use the editing metadata only to choose response structure. Do not infer facts outside the sources.',
                    `Editing metadata: ${JSON.stringify(editing)}`,
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
          `Gemini chat request failed: HTTP ${response.status}${await geminiErrorDetails(response)}`,
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
    async complete({ contextBundle, editing, projectSlug, question, report, sources }) {
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
                    'Use the editing metadata only to choose response structure. Do not infer facts outside the public report/context.',
                    `Editing metadata: ${JSON.stringify(editing)}`,
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

export function trimPrivateChatHistoryContent(
  content: string,
  maxLength = PRIVATE_CHAT_HISTORY_CONTENT_MAX,
): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength - 1)}…`;
}

export function privateChatHistorySourcesForStorage(sources: readonly ChatSource[]): ChatSource[] {
  return sources.map((source) => ({
    canonicalUri: source.canonicalUri,
    documentId: source.documentId,
    docType: source.docType,
    rawDocumentId: source.rawDocumentId,
    title: source.title,
  }));
}

export function privateChatHistoryToMastraMessages(
  history: readonly PrivateChatHistoryItem[],
): MastraChatHistoryMessage[] {
  const turns = history.slice(-PRIVATE_CHAT_CONTEXT_TURN_LIMIT);
  const messages: MastraChatHistoryMessage[] = [];
  for (const turn of turns) {
    messages.push({
      role: 'user',
      content: trimPrivateChatHistoryContent(turn.question),
    });
    messages.push({
      role: 'assistant',
      content: trimPrivateChatHistoryContent(turn.answer),
    });
  }
  return messages;
}

export function privateChatHistoryItemsForUiDisplay(
  itemsNewestFirst: readonly PrivateChatHistoryItem[],
): readonly PrivateChatHistoryItem[] {
  return [...itemsNewestFirst].reverse();
}

export function resolvePrivateChatHistoryApplyAction(input: {
  readonly currentMessageCount: number;
  readonly hasPendingAssistantMessage: boolean;
  readonly hasPendingRequest: boolean;
  readonly refresh: boolean;
}): 'apply' | 'keep' {
  if (input.refresh) {
    return input.hasPendingRequest || input.hasPendingAssistantMessage ? 'keep' : 'apply';
  }
  return input.currentMessageCount === 0 ? 'apply' : 'keep';
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

/**
 * Creates a Postgres-backed chat repository.
 *
 * @param options - Optional raw storage used to enable raw read view fetches
 * @returns A chat repository implementation backed by the provided SQL client
 */
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
      return access ? { graphName: access.graphName, id: access.id, slug: access.slug } : undefined;
    },
    async vectorSearch({ embedding, limit, projectId, query }) {
      const vector = `[${embedding.join(',')}]`;
      const keywordQuery = normalizeHybridKeywordQuery(query);
      if (keywordQuery.length === 0) {
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
          ORDER BY distance ASC NULLS LAST
          LIMIT ${limit}
        `) as readonly unknown[];
        return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
      }

      const candidateLimit = hybridSearchCandidateLimit(limit);
      const rows = (await sql`
        WITH vector_candidates AS (
          SELECT
            dc.id::text AS chunk_id,
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            left(coalesce(dc.content, d.summary, ''), 700) AS snippet,
            dc.embedding <=> ${vector}::vector AS distance,
            0.0 AS keyword_score
          FROM public.document_chunks dc
          JOIN public.documents d ON d.id = dc.document_id
          WHERE dc.project_id = ${projectId}
          ORDER BY dc.embedding <=> ${vector}::vector
          LIMIT ${candidateLimit}
        ),
        keyword_candidates_limit AS (
          SELECT
            dc.id AS chunk_id,
            dc.document_id,
            dc.content,
            dc.embedding,
            pgroonga_score(dc.tableoid, dc.ctid) AS keyword_score
          FROM public.document_chunks dc
          WHERE dc.project_id = ${projectId}
            AND dc.content &@~ pgroonga_query_escape(${keywordQuery})
          ORDER BY pgroonga_score(dc.tableoid, dc.ctid) DESC
          LIMIT ${candidateLimit}
        ),
        keyword_candidates AS (
          SELECT
            kcl.chunk_id::text AS chunk_id,
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            left(coalesce(kcl.content, d.summary, ''), 700) AS snippet,
            kcl.embedding <=> ${vector}::vector AS distance,
            kcl.keyword_score
          FROM keyword_candidates_limit kcl
          JOIN public.documents d ON d.id = kcl.document_id
        ),
        keyword_score_bounds AS (
          SELECT COALESCE(MAX(keyword_score), 0) AS max_score FROM keyword_candidates
        ),
        chunk_candidates AS (
          SELECT * FROM vector_candidates
          UNION ALL
          SELECT * FROM keyword_candidates
        ),
        scored_chunks AS (
          SELECT
            cc.chunk_id,
            cc.document_id,
            cc.raw_document_id,
            cc.doc_type,
            cc.title,
            cc.canonical_uri,
            cc.snippet,
            min(cc.distance) AS distance,
            max(cc.keyword_score) AS keyword_score,
            (
              0.75 * COALESCE(1.0 / (1.0 + min(cc.distance)), 0.0) +
              0.25 * CASE
                WHEN max(cc.keyword_score) > 0 AND bounds.max_score > 0
                THEN max(cc.keyword_score) / bounds.max_score
                ELSE 0
              END
            ) AS hybrid_score
          FROM chunk_candidates cc
          CROSS JOIN keyword_score_bounds bounds
          GROUP BY
            cc.chunk_id,
            cc.document_id,
            cc.raw_document_id,
            cc.doc_type,
            cc.title,
            cc.canonical_uri,
            cc.snippet,
            bounds.max_score
        ),
        distinct_chunks AS (
          SELECT DISTINCT ON (document_id)
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            distance,
            hybrid_score
          FROM scored_chunks
          ORDER BY document_id, hybrid_score DESC NULLS LAST, distance ASC NULLS LAST
        )
        SELECT document_id, raw_document_id, doc_type, title, canonical_uri, snippet
        FROM distinct_chunks
        ORDER BY hybrid_score DESC NULLS LAST, distance ASC NULLS LAST
        LIMIT ${limit}
      `) as readonly unknown[];
      return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
    },
    async graphQuery({ graphName, limit, projectId, query, seedDocumentIds }) {
      const seedIds = seedDocumentIds ?? [];
      let relatedDocumentIds: readonly GraphRelatedDocumentCandidate[] = [];
      if (graphName && seedIds.length > 0) {
        try {
          relatedDocumentIds = await queryGraphRelatedDocumentIds(sql, {
            graphName,
            limit,
            projectId,
            seedDocumentIds: seedIds,
          });
        } catch {
          relatedDocumentIds = [];
        }
      }
      if (relatedDocumentIds.length > 0) {
        const candidates = await fetchChatSourcesByDocumentIds(sql, {
          documentIds: relatedDocumentIds.map((candidate) => candidate.documentId),
          projectId,
        });
        const byDocumentId = new Map(candidates.map((source) => [source.documentId, source]));
        const acceptedSources = relatedDocumentIds
          .map((candidate) => {
            const source = byDocumentId.get(candidate.documentId);
            return source
              ? ({
                  ...source,
                  hopCount: candidate.hopCount,
                  relationType: candidate.relationType,
                  seedDocumentId: candidate.seedDocumentId,
                } satisfies ChatGraphRelatedSource)
              : undefined;
          })
          .filter((candidate): candidate is ChatGraphRelatedSource => Boolean(candidate))
          .filter((candidate) =>
            shouldUseGraphRelatedSource({
              candidate,
              question: query,
              seedDocumentIds: seedIds,
            }),
          )
          .slice(0, limit);
        if (acceptedSources.length > 0) {
          return acceptedSources;
        }
      }
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
      return fetchChatSourcesByDocumentIds(sql, { documentIds, projectId });
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
    async listPrivateChatHistoryForContext({ limit, projectId, userId }) {
      const rows = await readPrivateChatHistoryRows(
        () => sql`
          SELECT
            id::text AS id,
            question,
            answer,
            sources,
            tool_calls,
            editing,
            created_at
          FROM public.private_chat_messages
          WHERE project_id = ${projectId}
            AND user_id = ${userId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit ?? PRIVATE_CHAT_CONTEXT_TURN_LIMIT}
        `,
      );
      return rows
        .map((row) => privateChatHistoryItemFromRow(parsePrivateChatHistoryRow(row)))
        .reverse();
    },
    async listPrivateChatHistoryForUi({ limit, projectId, userId }) {
      const rows = await readPrivateChatHistoryRows(
        () => sql`
          SELECT
            id::text AS id,
            question,
            answer,
            sources,
            tool_calls,
            editing,
            created_at
          FROM public.private_chat_messages
          WHERE project_id = ${projectId}
            AND user_id = ${userId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit ?? PRIVATE_CHAT_HISTORY_UI_LIMIT}
        `,
      );
      return privateChatHistoryItemsForUiDisplay(
        rows.map((row) => privateChatHistoryItemFromRow(parsePrivateChatHistoryRow(row))),
      );
    },
    async savePrivateChatTurn(input) {
      const rows = await sql`
        INSERT INTO public.private_chat_messages (
          project_id,
          user_id,
          question,
          answer,
          sources,
          tool_calls,
          editing
        )
        VALUES (
          ${input.projectId},
          ${input.userId},
          ${input.question},
          ${input.answer},
          ${JSON.stringify(privateChatHistorySourcesForStorage(input.sources))}::jsonb,
          ${JSON.stringify(input.toolCalls)}::jsonb,
          ${input.editing ? JSON.stringify(input.editing) : null}
        )
        RETURNING
          id::text AS id,
          question,
          answer,
          sources,
          tool_calls,
          editing,
          created_at
      `;
      const row = rows[0];
      if (!row) {
        throw new Error('Private chat turn save failed.');
      }
      return privateChatHistoryItemFromRow(parsePrivateChatHistoryRow(row));
    },
  };
}

async function readPrivateChatHistoryRows(
  query: () => Promise<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await query();
  } catch (error) {
    if (isMissingPrivateChatHistoryTableError(error)) {
      return [];
    }
    throw error;
  }
}

export function isMissingPrivateChatHistoryTableError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const code = error.code;
  const message = error.message;
  return (
    code === '42P01' &&
    typeof message === 'string' &&
    message.includes('private_chat_messages')
  );
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
  readonly editing?: ChatEditingMetadata;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly sources?: readonly PublicChatSource[];
  readonly status: PublicChatResponse['status'];
  readonly toolCalls?: readonly PublicChatToolCall[];
}): PublicChatResponse {
  return {
    answer: input.answer,
    ...(input.editing ? { editing: input.editing } : {}),
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

export interface PrivateChatHistoryRow {
  readonly answer: string;
  readonly created_at: unknown;
  readonly editing: unknown;
  readonly id: string;
  readonly question: string;
  readonly sources: unknown;
  readonly tool_calls: unknown;
}

export function parsePrivateChatHistoryRow(value: unknown): PrivateChatHistoryRow {
  if (!isRecord(value)) {
    throw new Error('Invalid private chat history row.');
  }
  return {
    answer: parseRequiredString(value.answer, 'answer'),
    created_at: value.created_at,
    editing: value.editing,
    id: parseRequiredString(value.id, 'id'),
    question: parseRequiredString(value.question, 'question'),
    sources: value.sources,
    tool_calls: value.tool_calls,
  };
}

function privateChatHistoryItemFromRow(row: PrivateChatHistoryRow): PrivateChatHistoryItem {
  return {
    answer: row.answer,
    createdAt: parsePrivateChatHistoryCreatedAt(row.created_at),
    editing: parseOptionalChatEditingMetadata(row.editing),
    id: row.id,
    question: row.question,
    sources: parseStoredChatSources(row.sources),
    toolCalls: parseStoredChatToolCalls(row.tool_calls),
  };
}

function parsePrivateChatHistoryCreatedAt(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new Error('Invalid private chat history created_at.');
}

function parseStoredChatSources(value: unknown): ChatSource[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid private chat history sources.');
  }
  return value.map(parseStoredChatSource);
}

function parseStoredChatSource(value: unknown): ChatSource {
  if (!isRecord(value)) {
    throw new Error('Invalid stored chat source.');
  }
  return {
    canonicalUri: parseRequiredString(value.canonicalUri, 'canonicalUri'),
    documentId: parseRequiredString(value.documentId, 'documentId'),
    docType: parseRequiredString(value.docType, 'docType'),
    rawDocumentId: parseRequiredString(value.rawDocumentId, 'rawDocumentId'),
    snippet: parseOptionalNullableString(value.snippet, 'snippet') ?? undefined,
    title: parseRequiredString(value.title, 'title'),
  };
}

function parseStoredChatToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid private chat history tool_calls.');
  }
  return value.map(parseStoredChatToolCall);
}

function parseStoredChatToolCall(value: unknown): ChatToolCall {
  if (!isRecord(value)) {
    throw new Error('Invalid stored chat tool call.');
  }
  return {
    name: parseChatToolName(value.name),
    resultCount: parseNonNegativeInteger(value.resultCount, 'resultCount'),
  };
}

function parseChatToolName(value: unknown): ChatToolName {
  if (
    value === 'document-fetch' ||
    value === 'graph-query' ||
    value === 'parsed-doc-fetch' ||
    value === 'raw-document-fetch' ||
    value === 'vector-search'
  ) {
    return value;
  }
  throw new Error(`Invalid chat tool name: ${String(value)}`);
}

function parseOptionalChatEditingMetadata(value: unknown): ChatEditingMetadata | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid private chat history editing.');
  }
  const caveats = value.caveats;
  const confidence = value.confidence;
  const inferredMode = value.inferredMode;
  const operations = value.operations;
  const questionType = value.questionType;
  if (
    !Array.isArray(caveats) ||
    !Array.isArray(operations) ||
    (confidence !== 'high' && confidence !== 'low' && confidence !== 'medium') ||
    !isChatEditingMode(inferredMode) ||
    !isChatEditingQuestionType(questionType)
  ) {
    throw new Error('Invalid private chat history editing.');
  }
  return {
    caveats: caveats.map((item) => parseRequiredString(item, 'caveats')),
    confidence,
    inferredMode,
    operations: operations.map((item) => parseRequiredString(item, 'operations')),
    questionType,
  };
}

function isChatEditingMode(value: unknown): value is ChatEditingMode {
  return (
    value === 'default' ||
    value === 'issue_mapping' ||
    value === 'next_actions' ||
    value === 'risk_scan' ||
    value === 'structure' ||
    value === 'summary' ||
    value === 'timeline'
  );
}

function isChatEditingQuestionType(value: unknown): value is ChatEditingQuestionType {
  return (
    value === 'fact' ||
    value === 'planning' ||
    value === 'public_explanation' ||
    value === 'risk' ||
    value === 'status' ||
    value === 'timeline' ||
    value === 'unknown'
  );
}

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`Invalid private chat history field: ${fieldName}`);
}

/**
 * Converts a database row into a chat source.
 *
 * @returns The mapped chat source with trimmed snippet text.
 */
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

/**
 * ハイブリッド検索の候補数上限を算出します。
 *
 * @param limit - 基準となる取得件数
 * @returns pgvector / PGroonga の候補数上限
 */
export function hybridSearchCandidateLimit(limit: number): number {
  return Math.min(
    Math.max(limit * 20, VECTOR_SEARCH_MIN_CANDIDATE_LIMIT),
    VECTOR_SEARCH_MAX_CANDIDATE_LIMIT,
  );
}

/**
 * Normalizes a query string for hybrid keyword search.
 *
 * Converts the text to NFKC, replaces ASCII control characters with spaces, collapses whitespace,
 * trims the result, and limits it to 512 characters. Inputs longer than 1024 characters are
 * truncated before normalization to limit CPU usage.
 *
 * @param query - The input query text
 * @returns The normalized query string, or an empty string when `query` is not a string
 */
export function normalizeHybridKeywordQuery(query: string | null | undefined): string {
  if (typeof query !== 'string') {
    return '';
  }
  const truncated = query.slice(0, HYBRID_KEYWORD_QUERY_INPUT_MAX);
  return Array.from(truncated.normalize('NFKC'))
    .map((character) => (isControlCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HYBRID_KEYWORD_QUERY_OUTPUT_MAX);
}

/**
 * 文字が ASCII 制御文字かどうかを判定する。
 *
 * @param character - 判定対象の文字
 * @returns `true` なら ASCII 制御文字、`false` それ以外
 */
function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
}

/**
 * Fetches chat sources for the specified documents.
 *
 * @param sql - Database connection.
 * @param input.documentIds - Document IDs to retrieve.
 * @param input.projectId - Project that owns the documents.
 * @returns Chat sources for the matching documents.
 */
async function fetchChatSourcesByDocumentIds(
  sql: postgres.Sql,
  input: { documentIds: readonly string[]; projectId: string },
): Promise<ChatSource[]> {
  if (input.documentIds.length === 0) {
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
    WHERE d.project_id = ${input.projectId}
      AND d.id IN ${sql(input.documentIds)}
    ORDER BY d.occurred_at DESC NULLS LAST, d.updated_at DESC
  `) as readonly unknown[];
  return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
}

export interface GraphRelatedDocumentCandidate {
  readonly documentId: string;
  readonly hopCount: 1 | 2;
  readonly relationType: ChatGraphRelationType;
  readonly seedDocumentId: string;
}

export interface GraphRelatedDocumentRows {
  readonly hopCount: 1 | 2;
  readonly relationType: ChatGraphRelationType;
  readonly rows: readonly unknown[];
}

export function selectGraphRelatedDocumentCandidates(input: {
  limit: number;
  relationRows: readonly GraphRelatedDocumentRows[];
}): GraphRelatedDocumentCandidate[] {
  const maxResults = Math.max(1, Math.min(input.limit, 10));
  const candidates: GraphRelatedDocumentCandidate[] = [];
  const seen = new Set<string>();
  for (const relationRows of input.relationRows) {
    if (candidates.length >= maxResults) {
      break;
    }
    for (const row of relationRows.rows) {
      if (!isRecord(row)) {
        continue;
      }
      const seedDocumentId = documentIdFromAgeVertex(row.seed);
      const documentId = documentIdFromAgeVertex(row.related);
      if (!seedDocumentId || !documentId || seen.has(documentId)) {
        continue;
      }
      seen.add(documentId);
      candidates.push({
        documentId,
        hopCount: relationRows.hopCount,
        relationType: relationRows.relationType,
        seedDocumentId,
      });
      if (candidates.length >= maxResults) {
        break;
      }
    }
  }
  return candidates;
}

async function queryGraphRelatedDocumentIds(
  sql: postgres.Sql,
  input: {
    graphName: string;
    limit: number;
    projectId: string;
    seedDocumentIds: readonly string[];
  },
): Promise<readonly GraphRelatedDocumentCandidate[]> {
  const safeGraphName = validateAgeGraphName(input.graphName);
  const seedDocumentIds = [...new Set(input.seedDocumentIds)].slice(0, 10);
  if (seedDocumentIds.length === 0) {
    return [];
  }
  const maxResults = Math.max(1, Math.min(input.limit, 10));
  const projectIdLiteral = cypherString(input.projectId);
  const seedIdList = seedDocumentIds.map(cypherString).join(', ');
  const whereBase = `seed.projectId = ${projectIdLiteral}
  AND related.projectId = ${projectIdLiteral}
  AND seed.documentId IN [${seedIdList}]
  AND NOT related.documentId IN [${seedIdList}]`;
  const relationQueries: Array<{
    cypher: string;
    hopCount: 1 | 2;
    relationType: ChatGraphRelationType;
  }> = [
    {
      cypher: `MATCH (seed:Document)-[:SAME_AS]-(related:Document)
WHERE ${whereBase}
RETURN DISTINCT seed, related
ORDER BY seed.documentId, related.documentId`,
      hopCount: 1,
      relationType: 'SAME_AS',
    },
    {
      cypher: `MATCH (seed:Document)-[:RELATED_TO]-(related:Document)
WHERE ${whereBase}
RETURN DISTINCT seed, related
ORDER BY seed.documentId, related.documentId`,
      hopCount: 1,
      relationType: 'RELATED_TO',
    },
    {
      cypher: `MATCH (seed:Document)-[:MENTIONS]-(topic:Topic)-[:MENTIONS]-(related:Document)
WHERE seed.projectId = ${projectIdLiteral}
  AND topic.projectId = ${projectIdLiteral}
  AND related.projectId = ${projectIdLiteral}
  AND seed.documentId IN [${seedIdList}]
  AND NOT related.documentId IN [${seedIdList}]
RETURN DISTINCT seed, related
ORDER BY seed.documentId, related.documentId`,
      hopCount: 2,
      relationType: 'MENTIONS',
    },
  ];
  const relationRows: GraphRelatedDocumentRows[] = [];
  await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    await transaction`LOAD 'age'`;
    await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
    await transaction`SET LOCAL statement_timeout = '5000ms'`;
    for (const relationQuery of relationQueries) {
      const cypher = `${relationQuery.cypher}
LIMIT ${maxResults}`;
      const rows = (await transaction.unsafe(
        `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
          cypher,
        )}) AS (seed agtype, related agtype)`,
      )) as readonly unknown[];
      relationRows.push({
        hopCount: relationQuery.hopCount,
        relationType: relationQuery.relationType,
        rows,
      });
    }
  });
  return selectGraphRelatedDocumentCandidates({ limit: maxResults, relationRows });
}

function documentIdFromAgeVertex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.endsWith('::vertex')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value.slice(0, -'::vertex'.length)) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.properties)) {
      return undefined;
    }
    const documentId = parsed.properties.documentId;
    return typeof documentId === 'string' && documentId ? documentId : undefined;
  } catch {
    return undefined;
  }
}

function validateAgeGraphName(graphName: string): string {
  if (!/^graph_[a-z0-9_]+$/.test(graphName) || graphName.length > 63) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
  return graphName;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cypherString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
