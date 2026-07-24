import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { lookupProjectMemberAccess } from './authz.ts';
import {
  type ChatSearchPeriod,
  hasChatSearchPeriod,
  validateChatSearchPeriod,
} from './chat-search-period.ts';
import { jsonParameter } from './postgres-json.ts';
import {
  type AgentRawReadViewEnvelope,
  createPostgresRawReadViewRepository,
  type RawReadViewRequest,
} from './raw-read-view.ts';
import type { PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';

/** Candidate and compatibility ceiling used outside the project-configured final selection. */
export const MAX_CHAT_RESPONSE_SOURCES = 10;

export type { ChatSearchPeriod } from './chat-search-period.ts';
export {
  CHAT_SEARCH_CALENDAR_YEAR_MAX,
  CHAT_SEARCH_CALENDAR_YEAR_MIN,
  CHAT_SEARCH_ISO_INSTANT_PATTERN,
  CHAT_SEARCH_PERIOD_MAX_SPAN_DAYS,
  hasChatSearchPeriod,
  isChatSearchIsoInstant,
  normalizeTimelineTopicQuery,
  parseChatSearchPeriod,
  validateChatSearchPeriod,
} from './chat-search-period.ts';

export type ChatToolName =
  | 'document-fetch'
  | 'graph-query'
  | 'parsed-doc-fetch'
  | 'raw-document-fetch'
  | 'timeline-search'
  | 'hybrid-search';

export type PublicChatToolName = ChatToolName | 'public-context-fetch' | 'public-report-fetch';

export interface ChatSource {
  readonly canonicalUri: string;
  readonly documentId: string;
  readonly docType: string;
  /** Retrieval-only selected chunk id. It is never persisted or returned by chat response APIs. */
  readonly chunkId?: string;
  /** Retrieval-only selected chunk index. It is never persisted or returned by chat response APIs. */
  readonly chunkIndex?: number;
  /** Retrieval-only RRF score normalized to 0..1. It is never persisted or returned by chat response APIs. */
  readonly fusedScore?: number;
  /**
   * Normalized UTC ISO-8601 document occurrence time (`...Z`) used during synthesis.
   * `null` means the time is unknown; `undefined` means the retrieval path did not project it.
   */
  readonly occurredAt?: string | null;
  readonly rawDocumentId: string;
  readonly snippet?: string;
  readonly title: string;
  /** Retrieval-only pgvector cosine distance; smaller values are more similar. */
  readonly vectorDistance?: number;
  /** One-based rank of this document in the pgvector candidate list. */
  readonly vectorRank?: number;
  /** One-based rank of this document in the PGroonga candidate list. */
  readonly keywordRank?: number;
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
  readonly status: 'answered' | 'rate_limited';
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

export type ChatErrorResponse = {
  readonly error?: string | { readonly code?: string; readonly message?: string };
};

export interface MastraChatHistoryMessage {
  readonly content: string;
  readonly role: 'assistant' | 'user';
}

export const PRIVATE_CHAT_CONTEXT_TURN_LIMIT = 6;
export const PRIVATE_CHAT_HISTORY_UI_LIMIT = 50;
export const PRIVATE_CHAT_HISTORY_CONTENT_MAX = 4000;
export const PRIVATE_CHAT_VECTOR_DIMENSIONS = 1536;
export const RECIPROCAL_RANK_FUSION_K = 60;

export interface ChatEmbeddingProvider {
  readonly dimensions: number;
  embedTexts(texts: string[]): Promise<number[][]>;
  readonly model: string;
}

export type PrivateChatRequestBodyParseResult =
  | { readonly includeHistory: boolean; readonly ok: true; readonly question: string }
  | { readonly error: string; readonly ok: false };

export function parsePrivateChatRequestBody(body: unknown): PrivateChatRequestBodyParseResult {
  if (!isRecord(body)) {
    return { error: 'request body must be an object', ok: false };
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return { error: 'question is required', ok: false };
  }
  if ('includeHistory' in body && typeof body.includeHistory !== 'boolean') {
    return { error: 'includeHistory must be a boolean', ok: false };
  }
  return {
    includeHistory: typeof body.includeHistory === 'boolean' ? body.includeHistory : true,
    ok: true,
    question,
  };
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

export function publicChatToolCallsFromPrivate(
  toolCalls?: readonly ChatToolCall[],
): PublicChatToolCall[] {
  return (toolCalls ?? []).map((toolCall) => ({
    name: toolCall.name,
    resultCount: toolCall.resultCount,
  }));
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
  lookupProjectMember(input: { projectSlug: string; userId: string }): Promise<
    | {
        readonly graphName: string | null;
        readonly hybridSearchDocumentLimit: number;
        readonly id: string;
        readonly slug: string;
      }
    | undefined
  >;
  parsedDocFetch(input: { limit: number; projectId: string }): Promise<ChatSource[]>;
  rawDocumentFetch(input: {
    limit: number;
    maxBytes: number;
    projectId: string;
  }): Promise<ChatSource[]>;
  rawReadViewFetch(input: RawReadViewRequest): Promise<AgentRawReadViewEnvelope | undefined>;
  timelineSearch(input: {
    limit: number;
    period?: ChatSearchPeriod;
    projectId: string;
    query: string;
  }): Promise<ChatSource[]>;
  hybridSearch(input: {
    embedding: readonly number[];
    embeddingModel: string;
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
  readonly embeddingProvider: ChatEmbeddingProvider;
  readonly provider: ChatProvider;
  readonly rateLimiter?: ChatRateLimiter;
  readonly repository: ChatRepository;
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

export function timelineSearchPatterns(query: string): string[] {
  const normalized = normalizeSpaces(query);
  const candidates = [
    normalized,
    stripAfterAny(normalized, ['について', 'に関する']),
    stripAfterAny(normalized, ['の経緯', 'の履歴', 'の流れ']),
  ]
    .map((candidate) => timelineSearchQueryText(candidate).trim())
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

/**
 * Infers private-chat editing metadata from the question text.
 *
 * Recognized deterministic period phrases force the timeline mode even when no timeline keyword matches.
 *
 * @param question - Raw user question text
 * @param nowIso - Optional explicit current instant for period recognition; defaults to `new Date().toISOString()`
 */
export function inferChatEditingMetadata(
  question: string,
  nowIso: string = new Date().toISOString(),
): ChatEditingMetadata {
  if (hasChatSearchPeriod(question, nowIso)) {
    return editingMetadataFromMode('timeline', 'high');
  }
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

function timelineSearchQueryText(query: string): string {
  let output = normalizeSpaces(query);
  const noisePatterns = [
    /timeline/gi,
    /history/gi,
    /時系列/g,
    /履歴/g,
    /経緯/g,
    /流れ/g,
    /いつ決ま/g,
    /なぜ判断/g,
    /について/g,
    /に関する/g,
    /教えて/g,
    /ください/g,
    /知りたい/g,
    /まとめて/g,
    /説明して/g,
  ];
  for (const pattern of noisePatterns) {
    output = output.replace(pattern, ' ');
  }
  output = normalizeSpaces(output)
    .replace(/^(現在の|最新の|現在|最新)/, '')
    .replace(/[、。?？!！]/g, ' ')
    .replace(/[のをではがに]+/g, ' ');
  return normalizeSpaces(output);
}

export interface RunPublicChatOptions {
  readonly contextBundle: PublicContextBundleV1;
  readonly provider: PublicChatProvider;
  readonly rateLimiters?: readonly PublicChatRateLimiter[];
  readonly report: PublicReportJsonV1;
}

const VECTOR_SEARCH_MIN_CANDIDATE_LIMIT = 50;
const VECTOR_SEARCH_MAX_CANDIDATE_LIMIT = 200;
const HYBRID_KEYWORD_QUERY_INPUT_MAX = 1024;
const HYBRID_KEYWORD_QUERY_OUTPUT_MAX = 512;

/**
 * Runs the private chat workflow for an authorized project member.
 *
 * Retrieves relevant project sources and generates an answer using the configured chat provider.
 *
 * @param request - The private chat request
 * @param options - The chat runtime dependencies
 * @returns A rate-limited response or an answered response with up to ten retrieved sources
 * @throws ProjectAccessDeniedError If the user does not have access to the project
 */
export async function runPrivateChat(
  request: ChatRequest,
  options: RunPrivateChatOptions,
): Promise<ChatResponse> {
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
  const shouldPrioritizeTimeline = editing.inferredMode === 'timeline';
  const [embedding] = await embedPrivateChatQueries(options.embeddingProvider, [request.question]);
  if (!embedding) {
    throw new Error('Private chat query embedding is unavailable.');
  }
  const sourceLimit = project.hybridSearchDocumentLimit;
  const hybridSources = await options.repository.hybridSearch({
    embedding,
    embeddingModel: options.embeddingProvider.model,
    limit: sourceLimit,
    projectId: project.id,
    query: request.question,
  });
  const timelineSourcesPromise = shouldPrioritizeTimeline
    ? options.repository.timelineSearch({
        limit: sourceLimit,
        projectId: project.id,
        query: request.question,
      })
    : Promise.resolve([] satisfies ChatSource[]);
  const [graphSources, timelineSources, rawSources, parsedSources] = await Promise.all([
    options.repository.graphQuery({
      graphName: project.graphName,
      limit: sourceLimit,
      projectId: project.id,
      query: request.question,
      seedDocumentIds: hybridSources.map((source) => source.documentId),
    }),
    timelineSourcesPromise,
    options.repository.rawDocumentFetch({
      limit: sourceLimit,
      maxBytes: 64 * 1024,
      projectId: project.id,
    }),
    options.repository.parsedDocFetch({
      limit: sourceLimit,
      projectId: project.id,
    }),
  ]);
  const documentSources = await options.repository.documentFetch({
    documentIds: hybridSources.map((source) => source.documentId),
    projectId: project.id,
  });
  const timelineSourceBudget = shouldPrioritizeTimeline ? Math.min(timelineSources.length, 2) : 0;
  const graphSourceBudget = Math.min(graphSources.length, shouldPrioritizeTimeline ? 1 : 2);
  const hybridSourceBudget = Math.max(0, sourceLimit - graphSourceBudget - timelineSourceBudget);
  const sources = uniqueSources([
    ...(shouldPrioritizeTimeline
      ? [
          ...timelineSources.slice(0, timelineSourceBudget),
          ...graphSources.slice(0, graphSourceBudget),
          ...hybridSources.slice(0, hybridSourceBudget),
          ...timelineSources.slice(timelineSourceBudget),
          ...hybridSources.slice(hybridSourceBudget),
        ]
      : [
          ...hybridSources.slice(0, hybridSourceBudget),
          ...graphSources.slice(0, graphSourceBudget),
          ...hybridSources.slice(hybridSourceBudget),
        ]),
    ...documentSources,
    ...rawSources,
    ...parsedSources,
  ]).slice(0, sourceLimit);

  return {
    answer: await options.provider.complete({ editing, question: request.question, sources }),
    editing,
    projectSlug: request.projectSlug,
    sources: privateChatSourcesForResponse(sources),
    status: 'answered',
    toolCalls: [
      { name: 'hybrid-search', resultCount: hybridSources.length },
      { name: 'graph-query', resultCount: graphSources.length },
      ...(shouldPrioritizeTimeline
        ? [{ name: 'timeline-search' as const, resultCount: timelineSources.length }]
        : []),
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

/**
 * Creates an in-memory rate limiter keyed by client IP and report ID.
 *
 * @param input - Rate-limit window, request limit, clock, and cleanup configuration
 * @returns A public chat rate limiter
 */
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

/**
 * Truncates private chat history content to the specified maximum length.
 *
 * @param content - The content to truncate
 * @param maxLength - The maximum number of characters to retain
 * @returns The original content when within the limit, or truncated content ending with an ellipsis
 */
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

/**
 * Removes retrieval-only score fields before private chat sources cross an API boundary.
 *
 * @param sources - Sources used by the private retrieval pipeline
 * @returns Sources safe to include in private chat responses and browser state
 */
export function privateChatSourcesForResponse(sources: readonly ChatSource[]): ChatSource[] {
  return sources.map((source) => ({
    canonicalUri: source.canonicalUri,
    documentId: source.documentId,
    docType: source.docType,
    rawDocumentId: source.rawDocumentId,
    ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
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

/**
 * Orders private chat history items from oldest to newest for UI display.
 *
 * @param itemsNewestFirst - Chat history items ordered from newest to oldest
 * @returns The items ordered from oldest to newest
 */
export function privateChatHistoryItemsForUiDisplay(
  itemsNewestFirst: readonly PrivateChatHistoryItem[],
): readonly PrivateChatHistoryItem[] {
  return [...itemsNewestFirst].reverse();
}

/**
 * Creates a Postgres-backed chat repository with project-scoped RRF hybrid retrieval.
 *
 * @param options - Optional raw storage used to enable raw read view fetches
 * @returns A repository that filters vector candidates by embedding model and keeps keyword retrieval model-independent
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
      return access
        ? {
            graphName: access.graphName,
            hybridSearchDocumentLimit: access.hybridSearchDocumentLimit,
            id: access.id,
            slug: access.slug,
          }
        : undefined;
    },
    async hybridSearch({ embedding, embeddingModel, limit, projectId, query }) {
      const vector = `[${embedding.join(',')}]`;
      const keywordQuery = normalizeHybridKeywordQuery(query);
      if (keywordQuery.length === 0) {
        const rows = (await sql`
          WITH distinct_chunks AS (
            SELECT DISTINCT ON (d.id)
              dc.id::text AS chunk_id,
              dc.chunk_index,
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
              AND dc.embedding_model = ${embeddingModel}
              AND dc.embedding IS NOT NULL
            ORDER BY d.id, dc.embedding <=> ${vector}::vector, dc.id
          )
          SELECT
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            distance AS vector_distance,
            row_number() OVER (ORDER BY distance ASC NULLS LAST, document_id) AS vector_rank
          FROM distinct_chunks
          ORDER BY distance ASC NULLS LAST
          LIMIT ${limit}
        `) as readonly unknown[];
        return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
      }

      const candidateLimit = hybridSearchCandidateLimit(limit);
      const rows = (await sql`
        WITH vector_chunk_candidates_limit AS (
          SELECT
            dc.id::text AS chunk_id,
            dc.chunk_index,
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
            AND dc.embedding_model = ${embeddingModel}
            AND dc.embedding IS NOT NULL
          ORDER BY dc.embedding <=> ${vector}::vector, dc.id
          LIMIT ${candidateLimit}
        ),
        vector_document_candidates AS (
          SELECT DISTINCT ON (document_id)
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            distance
          FROM vector_chunk_candidates_limit
          ORDER BY document_id, distance, chunk_id
        ),
        vector_candidates AS (
          SELECT
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            distance,
            row_number() OVER (ORDER BY distance, chunk_id) AS vector_rank,
            NULL::bigint AS keyword_rank
          FROM vector_document_candidates
        ),
        keyword_chunk_candidates_limit AS (
          SELECT
            dc.id::text AS chunk_id,
            dc.chunk_index,
            dc.document_id,
            dc.content,
            pgroonga_score(dc.tableoid, dc.ctid) AS keyword_score
          FROM public.document_chunks dc
          WHERE dc.project_id = ${projectId}
            AND dc.content &@~ pgroonga_query_escape(${keywordQuery})
          ORDER BY pgroonga_score(dc.tableoid, dc.ctid) DESC, dc.id
          LIMIT ${candidateLimit}
        ),
        keyword_document_candidates AS (
          SELECT DISTINCT ON (d.id)
            kcl.chunk_id,
            kcl.chunk_index,
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            left(coalesce(kcl.content, d.summary, ''), 700) AS snippet,
            kcl.keyword_score
          FROM keyword_chunk_candidates_limit kcl
          JOIN public.documents d ON d.id = kcl.document_id
          ORDER BY d.id, kcl.keyword_score DESC, kcl.chunk_id
        ),
        keyword_candidates AS (
          SELECT
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            NULL::double precision AS distance,
            NULL::bigint AS vector_rank,
            row_number() OVER (ORDER BY keyword_score DESC, chunk_id) AS keyword_rank
          FROM keyword_document_candidates
        ),
        document_candidates AS (
          SELECT * FROM vector_candidates
          UNION ALL
          SELECT * FROM keyword_candidates
        ),
        document_scores AS (
          SELECT
            document_id,
            min(vector_rank) AS vector_rank,
            min(keyword_rank) AS keyword_rank,
            min(distance) AS vector_distance,
            COALESCE(1.0 / (${RECIPROCAL_RANK_FUSION_K} + min(vector_rank)), 0.0) +
              COALESCE(1.0 / (${RECIPROCAL_RANK_FUSION_K} + min(keyword_rank)), 0.0)
              AS rrf_score
          FROM document_candidates
          GROUP BY document_id
        ),
        document_display AS (
          SELECT DISTINCT ON (document_id)
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            chunk_id,
            chunk_index
          FROM document_candidates
          ORDER BY
            document_id,
            LEAST(
              COALESCE(vector_rank, 2147483647),
              COALESCE(keyword_rank, 2147483647)
            ),
            CASE WHEN vector_rank IS NULL THEN 1 ELSE 0 END,
            chunk_id
        )
        SELECT
          dd.document_id,
          dd.raw_document_id,
          dd.doc_type,
          dd.title,
          dd.canonical_uri,
          dd.snippet,
          dd.chunk_id,
          dd.chunk_index,
          ds.vector_distance,
          ds.vector_rank,
          ds.keyword_rank,
          ds.rrf_score AS fused_score
        FROM document_scores ds
        JOIN document_display dd USING (document_id)
        ORDER BY
          ds.rrf_score DESC,
          LEAST(
            COALESCE(ds.vector_rank, 2147483647),
            COALESCE(ds.keyword_rank, 2147483647)
          ),
          dd.document_id
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
    async timelineSearch({ limit, period, projectId, query }) {
      if (period) {
        validateChatSearchPeriod(period);
      }
      const queryText = timelineSearchQueryText(query);
      const keywordQuery = normalizeHybridKeywordQuery(queryText);
      const searchPatterns = timelineSearchPatterns(query);
      const periodStartAt = period?.startAt ?? null;
      const periodEndAt = period?.endAt ?? null;
      if (keywordQuery.length === 0 && searchPatterns.length === 0) {
        if (periodStartAt !== null) {
          const rows = (await sql`
            WITH period_candidates AS (
              SELECT
                d.id,
                d.project_id,
                d.raw_document_id,
                d.doc_type,
                d.title,
                d.canonical_uri,
                d.summary,
                d.occurred_at,
                d.updated_at
              FROM public.documents d
              WHERE d.project_id = ${projectId}
                AND d.occurred_at >= ${periodStartAt}::timestamptz
                AND d.occurred_at < ${periodEndAt}::timestamptz
            ),
            ranked AS (
              SELECT
                period_candidates.*,
                row_number() OVER (
                  ORDER BY
                    period_candidates.occurred_at ASC NULLS LAST,
                    period_candidates.updated_at ASC,
                    period_candidates.id ASC
                ) AS chronological_rank,
                count(*) OVER () AS total_count
              FROM period_candidates
            ),
            bounds AS (
              SELECT coalesce(max(ranked.total_count), 0) AS total_count
              FROM ranked
            ),
            target_ranks AS (
              SELECT DISTINCT
                CASE
                  WHEN ${limit} = 1 THEN 1
                  WHEN bounds.total_count <= ${limit} THEN series.idx
                  ELSE 1 + floor(
                    (series.idx - 1)::numeric * (bounds.total_count - 1) / (${limit} - 1)
                  )::int
                END AS target_rank
              FROM bounds
              CROSS JOIN generate_series(
                1,
                CASE
                  WHEN bounds.total_count = 0 THEN 0
                  ELSE least(${limit}, bounds.total_count)
                END
              ) AS series(idx)
            )
            SELECT
              ranked.id::text AS document_id,
              ranked.raw_document_id::text AS raw_document_id,
              ranked.doc_type,
              coalesce(ranked.title, 'Untitled') AS title,
              coalesce(ranked.canonical_uri, '') AS canonical_uri,
              CASE
                WHEN ranked.occurred_at IS NULL THEN NULL
                ELSE to_char(
                  ranked.occurred_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
              END AS occurred_at,
              left(coalesce(ranked.summary, dc.content, ''), 700) AS snippet
            FROM ranked
            INNER JOIN target_ranks
              ON ranked.chronological_rank = target_ranks.target_rank
            LEFT JOIN LATERAL (
              SELECT content
              FROM public.document_chunks
              WHERE project_id = ranked.project_id
                AND document_id = ranked.id
              ORDER BY chunk_index ASC
              LIMIT 1
            ) dc ON true
            ORDER BY
              ranked.occurred_at ASC NULLS LAST,
              ranked.updated_at ASC,
              ranked.id ASC
          `) as readonly unknown[];
          return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
        }
        const rows = (await sql`
          SELECT
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            CASE
              WHEN d.occurred_at IS NULL THEN NULL
              ELSE to_char(d.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END AS occurred_at,
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
          ORDER BY d.occurred_at ASC NULLS LAST, d.updated_at ASC, d.id ASC
          LIMIT ${limit}
        `) as readonly unknown[];
        return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
      }
      if (keywordQuery.length === 0) {
        const rows = (await sql`
          SELECT
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            CASE
              WHEN d.occurred_at IS NULL THEN NULL
              ELSE to_char(d.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            END AS occurred_at,
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
              ${periodStartAt}::timestamptz IS NULL
              OR (
                d.occurred_at >= ${periodStartAt}::timestamptz
                AND d.occurred_at < ${periodEndAt}::timestamptz
              )
            )
            AND (
              d.title ILIKE ANY (${searchPatterns})
              OR d.summary ILIKE ANY (${searchPatterns})
            )
          ORDER BY d.occurred_at ASC NULLS LAST, d.updated_at ASC, d.id ASC
          LIMIT ${limit}
        `) as readonly unknown[];
        return rows.map((row) => sourceFromRow(parseChatSourceRow(row)));
      }
      const rows = (await sql`
        SELECT
          d.id::text AS document_id,
          d.raw_document_id::text AS raw_document_id,
          d.doc_type,
          coalesce(d.title, 'Untitled') AS title,
          coalesce(d.canonical_uri, '') AS canonical_uri,
          CASE
            WHEN d.occurred_at IS NULL THEN NULL
            ELSE to_char(d.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS occurred_at,
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
            ${periodStartAt}::timestamptz IS NULL
            OR (
              d.occurred_at >= ${periodStartAt}::timestamptz
              AND d.occurred_at < ${periodEndAt}::timestamptz
            )
          )
          AND (
            d.title ILIKE ANY (${searchPatterns})
            OR d.summary ILIKE ANY (${searchPatterns})
            OR EXISTS (
              SELECT 1
              FROM public.document_chunks dc_search
              WHERE dc_search.project_id = d.project_id
                AND dc_search.document_id = d.id
                AND dc_search.content &@~ pgroonga_query_escape(${keywordQuery})
            )
          )
        ORDER BY d.occurred_at ASC NULLS LAST, d.updated_at ASC, d.id ASC
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
      const rows = await listPrivateChatHistoryRows(sql, {
        limit: limit ?? PRIVATE_CHAT_CONTEXT_TURN_LIMIT,
        projectId,
        userId,
      });
      return rows
        .map((row) => privateChatHistoryItemFromRow(parsePrivateChatHistoryRow(row)))
        .reverse();
    },
    async listPrivateChatHistoryForUi({ limit, projectId, userId }) {
      const rows = await listPrivateChatHistoryRows(sql, {
        limit: limit ?? PRIVATE_CHAT_HISTORY_UI_LIMIT,
        projectId,
        userId,
      });
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
          ${jsonParameter(sql, privateChatHistorySourcesForStorage(input.sources))}::jsonb,
          ${jsonParameter(sql, input.toolCalls)}::jsonb,
          ${input.editing ? jsonParameter(sql, input.editing) : null}::jsonb
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

function listPrivateChatHistoryRows(
  sql: postgres.Sql,
  input: { readonly limit: number; readonly projectId: string; readonly userId: string },
): Promise<readonly unknown[]> {
  return readPrivateChatHistoryRows(
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
      WHERE project_id = ${input.projectId}
        AND user_id = ${input.userId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.limit}
    `,
  );
}

async function readPrivateChatHistoryRows<Row>(
  query: () => Promise<readonly Row[]>,
): Promise<readonly Row[]> {
  try {
    return await query();
  } catch (error) {
    if (isMissingPrivateChatHistoryTableError(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Determines whether an error indicates that the private chat history table is missing.
 *
 * @param error - The value to inspect
 * @returns `true` if the error has PostgreSQL code `42P01` and references `private_chat_messages`, `false` otherwise.
 */
export function isMissingPrivateChatHistoryTableError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const code = error.code;
  const message = error.message;
  return (
    code === '42P01' && typeof message === 'string' && message.includes('private_chat_messages')
  );
}

/**
 * Determines whether a value has the shape of a chat error response.
 *
 * @param value - The value to check
 * @returns `true` if the value is a chat error response, `false` otherwise.
 */
export function isChatErrorResponseBody(value: unknown): value is ChatErrorResponse {
  return isRecord(value) && 'error' in value;
}

export function isPrivateChatHistoryListResponse(
  value: unknown,
): value is PrivateChatHistoryListResponse {
  return isRecord(value) && Array.isArray(value.items);
}

/**
 * Determines whether a value has the shape of a chat response.
 *
 * @param value - The value to inspect
 * @returns `true` if the value has a string `status` property, `false` otherwise
 */
export function isChatResponseBody(value: unknown): value is ChatResponse {
  return isRecord(value) && typeof value.status === 'string';
}

/**
 * Determines whether a value has the shape of a public chat response.
 *
 * @param value - The value to check
 * @returns `true` if the value is an object with a string `status`, `false` otherwise.
 */
export function isPublicChatResponseBody(value: unknown): value is PublicChatResponse {
  return isRecord(value) && typeof value.status === 'string';
}

/**
 * Extracts a user-facing error message from a chat response.
 *
 * @param body - The response body containing error or answer details
 * @param status - The HTTP status used as a fallback message
 * @returns The error message, answer, or `HTTP ${status}` when no message is available
 */
export function chatErrorMessage(
  body: ChatResponse | PublicChatResponse | ChatErrorResponse | null,
  status: number,
): string {
  if (isChatErrorResponseBody(body) && body.error) {
    return typeof body.error === 'string'
      ? body.error
      : (body.error.message ?? body.error.code ?? `HTTP ${status}`);
  }
  if (isRecord(body) && 'answer' in body && typeof body.answer === 'string' && body.answer) {
    return body.answer;
  }
  return `HTTP ${status}`;
}

/**
 * Creates a public chat response from the supplied answer, metadata, sources, and tool calls.
 *
 * @param input - The response fields to include
 * @returns A normalized public chat response
 */
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
  readonly chunk_id?: string | null;
  readonly chunk_index?: number | null;
  readonly document_id: string;
  readonly doc_type: string;
  readonly occurred_at?: string | null;
  readonly raw_document_id: string;
  readonly snippet?: string | null;
  readonly title: string;
  readonly fused_score?: number | null;
  readonly vector_distance?: number | null;
  readonly vector_rank?: number | null;
  readonly keyword_rank?: number | null;
}

/**
 * Runtime-validates an unknown SQL row into a typed chat source row.
 *
 * Required string fields and optional score fields are validated. `occurred_at` may be
 * omitted, `null`, or a normalized UTC ISO-8601 string from SQL; values that are neither
 * `null` nor a string are rejected.
 *
 * @param value - Untrusted row value returned from a chat source SQL query
 * @returns A validated `ChatSourceRow` with optional score and timestamp fields
 * @throws When `value` is not a record or any field fails validation
 */
export function parseChatSourceRow(value: unknown): ChatSourceRow {
  if (!isRecord(value)) {
    throw new Error('Invalid chat source row.');
  }
  const {
    canonical_uri,
    chunk_id,
    chunk_index,
    document_id,
    doc_type,
    occurred_at,
    raw_document_id,
    snippet,
    title,
    fused_score,
    vector_distance,
    vector_rank,
    keyword_rank,
  } = value;
  const provenanceFields = {
    chunk_id: parseOptionalNonEmptyString(chunk_id, 'chunk_id'),
    chunk_index: parseOptionalNonNegativeInteger(chunk_index, 'chunk_index'),
  };
  validateChatSourceChunkProvenancePair(provenanceFields.chunk_id, provenanceFields.chunk_index);
  const scoreFields = {
    fused_score: parseOptionalFiniteNumber(fused_score, 'fused_score'),
    vector_distance: parseOptionalFiniteNumber(vector_distance, 'vector_distance'),
    vector_rank: parseOptionalPositiveInteger(vector_rank, 'vector_rank'),
    keyword_rank: parseOptionalPositiveInteger(keyword_rank, 'keyword_rank'),
  };
  return {
    canonical_uri: parseRequiredString(canonical_uri, 'canonical_uri'),
    document_id: parseRequiredString(document_id, 'document_id'),
    doc_type: parseRequiredString(doc_type, 'doc_type'),
    ...(occurred_at === undefined
      ? {}
      : { occurred_at: parseOptionalNullableString(occurred_at, 'occurred_at') }),
    raw_document_id: parseRequiredString(raw_document_id, 'raw_document_id'),
    snippet: parseOptionalNullableString(snippet, 'snippet'),
    title: parseRequiredString(title, 'title'),
    ...(provenanceFields.chunk_id === undefined ? {} : { chunk_id: provenanceFields.chunk_id }),
    ...(provenanceFields.chunk_index === undefined
      ? {}
      : { chunk_index: provenanceFields.chunk_index }),
    ...(scoreFields.fused_score === undefined ? {} : { fused_score: scoreFields.fused_score }),
    ...(scoreFields.vector_distance === undefined
      ? {}
      : { vector_distance: scoreFields.vector_distance }),
    ...(scoreFields.vector_rank === undefined ? {} : { vector_rank: scoreFields.vector_rank }),
    ...(scoreFields.keyword_rank === undefined ? {} : { keyword_rank: scoreFields.keyword_rank }),
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

export function privateChatHistoryItemFromRow(row: PrivateChatHistoryRow): PrivateChatHistoryItem {
  return {
    answer: row.answer,
    createdAt: parsePrivateChatHistoryCreatedAt(row.created_at),
    editing: parseOptionalPrivateChatHistoryJson(
      row,
      'editing',
      parseOptionalChatEditingMetadata,
      undefined,
    ),
    id: row.id,
    question: row.question,
    sources: parseOptionalPrivateChatHistoryJson(row, 'sources', parseStoredChatSources, []),
    toolCalls: parseOptionalPrivateChatHistoryJson(row, 'tool_calls', parseStoredChatToolCalls, []),
  };
}

function parseOptionalPrivateChatHistoryJson<T>(
  row: PrivateChatHistoryRow,
  fieldName: 'editing' | 'sources' | 'tool_calls',
  parse: (value: unknown) => T,
  fallback: T,
): T {
  try {
    return parse(row[fieldName]);
  } catch (error) {
    console.warn(
      'Invalid private chat history JSON field; falling back.',
      { fieldName, messageId: row.id },
      error,
    );
    return fallback;
  }
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
  for (const field of [
    'chunkId',
    'chunkIndex',
    'fusedScore',
    'keywordRank',
    'occurredAt',
    'vectorDistance',
    'vectorRank',
  ]) {
    if (field in value) {
      throw new Error('Invalid stored chat source.');
    }
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
  if (value === 'vector-search') {
    return 'hybrid-search';
  }
  if (
    value === 'document-fetch' ||
    value === 'graph-query' ||
    value === 'parsed-doc-fetch' ||
    value === 'raw-document-fetch' ||
    value === 'timeline-search' ||
    value === 'hybrid-search'
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

function parseOptionalFiniteNumber(value: unknown, fieldName: string): number | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // postgres.js may return float8 / numeric columns as strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new Error(`Invalid chat source field: ${fieldName}`);
}

function parseOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
): number | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  // postgres.js returns PostgreSQL bigint (e.g. row_number()) as string by default.
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new Error(`Invalid chat source field: ${fieldName}`);
}

function validateChatSourceChunkProvenancePair(
  chunkId: string | null | undefined,
  chunkIndex: number | null | undefined,
): void {
  const hasChunkId = chunkId !== undefined && chunkId !== null;
  const hasChunkIndex = chunkIndex !== undefined && chunkIndex !== null;
  if (hasChunkId !== hasChunkIndex) {
    throw new Error('Invalid chat source row: chunk_id and chunk_index must appear together.');
  }
}

function parseOptionalNonEmptyString(value: unknown, fieldName: string): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  throw new Error(`Invalid chat source field: ${fieldName}`);
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  fieldName: string,
): number | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new Error(`Invalid chat source field: ${fieldName}`);
}

/**
 * Converts a database row into a chat source.
 *
 * @returns The mapped chat source with trimmed snippet text.
 */
function sourceFromRow(row: ChatSourceRow): ChatSource {
  return {
    canonicalUri: row.canonical_uri,
    chunkId: row.chunk_id ?? undefined,
    chunkIndex: row.chunk_index ?? undefined,
    documentId: row.document_id,
    docType: row.doc_type,
    fusedScore: row.fused_score ?? undefined,
    ...(row.occurred_at === undefined ? {} : { occurredAt: row.occurred_at }),
    rawDocumentId: row.raw_document_id,
    snippet: row.snippet?.trim() || undefined,
    title: row.title,
    vectorDistance: row.vector_distance ?? undefined,
    vectorRank: row.vector_rank ?? undefined,
    keywordRank: row.keyword_rank ?? undefined,
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
    .replace(/([A-Za-z0-9])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '$1 $2')
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])([A-Za-z0-9])/gu, '$1 $2')
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
      CASE
        WHEN d.occurred_at IS NULL THEN NULL
        ELSE to_char(d.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS occurred_at,
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

export function isRecord(value: unknown): value is Record<string, unknown> {
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

/**
 * Embeds private-chat queries in the configured document embedding space.
 *
 * @param provider - Provider whose model and dimensions match indexed document chunks
 * @param queries - Bounded query strings to embed in one provider batch
 * @returns One finite vector per input query, preserving input order
 * @throws When the provider contract does not match the private-chat vector schema
 */
export async function embedPrivateChatQueries(
  provider: ChatEmbeddingProvider,
  queries: readonly string[],
): Promise<number[][]> {
  if (provider.dimensions !== PRIVATE_CHAT_VECTOR_DIMENSIONS) {
    throw new Error(
      `Private chat embedding dimensions must be ${PRIVATE_CHAT_VECTOR_DIMENSIONS}; got ${provider.dimensions}.`,
    );
  }
  if (provider.model.trim().length === 0) {
    throw new Error('Private chat embedding model is required.');
  }
  const vectors = await provider.embedTexts([...queries]);
  if (vectors.length !== queries.length) {
    throw new Error(
      `Private chat embedding count mismatch: expected ${queries.length}, got ${vectors.length}.`,
    );
  }
  for (const [index, vector] of vectors.entries()) {
    if (
      vector.length !== PRIVATE_CHAT_VECTOR_DIMENSIONS ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(`Invalid private chat embedding at index ${index}.`);
    }
  }
  return vectors;
}

/**
 * Returns the weighted contribution for one one-based rank in reciprocal rank fusion.
 *
 * @param rank - One-based position in a ranked retrieval result
 * @param weight - Relative importance of the ranked result list
 * @returns The deterministic RRF contribution, or zero for invalid ranks and weights
 */
export function reciprocalRankFusionScore(rank: number, weight = 1): number {
  if (!Number.isInteger(rank) || rank < 1 || !Number.isFinite(weight) || weight <= 0) {
    return 0;
  }
  return weight / (RECIPROCAL_RANK_FUSION_K + rank);
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
