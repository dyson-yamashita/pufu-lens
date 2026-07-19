import {
  type ChatEditingMetadata,
  type ChatEmbeddingProvider,
  type ChatRepository,
  type ChatSource,
  type ChatToolCall,
  embedPrivateChatQueries,
  inferChatEditingMetadata,
  reciprocalRankFusionScore,
} from './chat.ts';

export const PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS = {
  preparing: { id: 'preparing', label: '検索条件を準備しています' },
  classifying: { id: 'classifying', label: '質問の見方を整理しています' },
  expanding: { id: 'expanding', label: '検索語を展開しています' },
  retrieving: { id: 'retrieving', label: '関連資料を検索しています' },
  retrying: { id: 'retrying', label: '検索語を広げて再検索しています' },
  relating: { id: 'relating', label: '関連資料を確認しています' },
  timeline: { id: 'timeline', label: '時系列を確認しています' },
  reasoning: { id: 'reasoning', label: '根拠を整理して回答を生成しています' },
} as const;

export type PrivateChatSearchStageId = keyof typeof PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS;

export interface PrivateChatSearchRetrievalResult {
  readonly editing: ChatEditingMetadata;
  readonly retrievalContext: string;
  readonly sources: readonly ChatSource[];
  readonly toolCalls: readonly ChatToolCall[];
}

export interface PrivateChatSearchRetrievalInput {
  readonly embeddingProvider: ChatEmbeddingProvider;
  readonly graphName: string | null;
  readonly onStage?: (stage: PrivateChatSearchStageId) => void;
  readonly projectId: string;
  readonly question: string;
  readonly repository: ChatRepository;
}

const PRIMARY_VECTOR_LIMIT = 15;
const GRAPH_LIMIT = 5;
const TIMELINE_LIMIT = 5;
const DETAIL_DOCUMENT_LIMIT = 5;
const MAX_MERGED_SOURCES = 5;
const PRIMARY_QUERY_RRF_WEIGHT = 2;
export const MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS = 6;
export const MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH = 120;

export const PRIVATE_CHAT_EDITING_OPERATIONS = [
  'identification',
  'cause',
  'process',
  'timeline',
  'comparison',
  'relation',
  'evaluation',
  'decision',
  'general',
] as const;

export type PrivateChatEditingOperation = (typeof PRIVATE_CHAT_EDITING_OPERATIONS)[number];
export type PrivateChatPlanningConfidence = 'high' | 'low' | 'medium';

export type ChatScoreMetric = 'normalized_fused_score' | 'vector_distance';

/** Defines deterministic retrieval cutoffs for one score direction. */
export interface ChatSourceSelectionPolicy {
  readonly gapRatio?: number;
  readonly kMax: number;
  readonly kMin: number;
  readonly maxDistance?: number;
  readonly metric: ChatScoreMetric;
  readonly minNormalizedScore?: number;
  readonly relativeWindow?: number;
}

const PRIMARY_VECTOR_SELECTION_POLICY: ChatSourceSelectionPolicy = {
  gapRatio: 0.5,
  kMax: PRIMARY_VECTOR_LIMIT,
  kMin: 5,
  metric: 'vector_distance',
  relativeWindow: 0.15,
};

const FUSED_SOURCE_SELECTION_POLICY: ChatSourceSelectionPolicy = {
  gapRatio: 0.5,
  kMax: PRIMARY_VECTOR_LIMIT,
  kMin: 5,
  metric: 'normalized_fused_score',
  relativeWindow: 0.1,
};

/**
 * Holds measured cosine-distance ceilings by embedding model.
 *
 * Re-measure these values with `pnpm chat:measure-distances` whenever an embedding model changes.
 * Unknown models intentionally omit an absolute ceiling and retain the legacy score-profile behavior.
 */
const MAX_VECTOR_DISTANCE_BY_EMBEDDING_MODEL: Readonly<Record<string, number>> = {
  'gemini-embedding-2': 0.6,
};

function primaryVectorSelectionPolicyForModel(embeddingModel: string): ChatSourceSelectionPolicy {
  const maxDistance = MAX_VECTOR_DISTANCE_BY_EMBEDDING_MODEL[embeddingModel];
  if (maxDistance === undefined) {
    return PRIMARY_VECTOR_SELECTION_POLICY;
  }
  return {
    ...PRIMARY_VECTOR_SELECTION_POLICY,
    maxDistance,
  };
}

const REQUEST_NOISE_PHRASES = [
  '教えてください',
  '教えて下さい',
  '教えてほしい',
  '教えて',
  'ください',
  'について',
  'に関する情報',
  'に関する',
  '関連する情報',
  '対応実績',
  '実績',
  '状況',
  'を教えて',
] as const;

export interface PrivateChatSearchQueryPlan {
  readonly expandedQueries: readonly PrivateChatExpandedQueryCandidate[];
  readonly primaryQuery: string;
  readonly protectedAnchors: readonly string[];
  readonly simplifiedRetryQuery: string | null;
}

export interface PrivateChatQuestionClassification {
  readonly confidence: PrivateChatPlanningConfidence;
  readonly expectedEvidence: readonly string[];
  readonly figure: readonly string[];
  readonly ground: readonly string[];
  readonly primaryOperation: PrivateChatEditingOperation;
  readonly secondaryOperations: readonly PrivateChatEditingOperation[];
}

export interface PrivateChatExpandedQueryCandidate {
  readonly operation: PrivateChatEditingOperation;
  readonly purpose: string;
  readonly query: string;
}

export interface PrivateChatQueryExpansion {
  readonly queries: readonly PrivateChatExpandedQueryCandidate[];
}

export function mapWorkflowStepIdToUiStage(stepId: string): PrivateChatSearchStageId | null {
  switch (stepId) {
    case 'private-chat-preparing':
      return 'preparing';
    case 'private-chat-classifying':
      return 'classifying';
    case 'private-chat-expanding':
      return 'expanding';
    case 'private-chat-retrieving':
      return 'retrieving';
    case 'private-chat-retrying':
      return 'retrying';
    case 'private-chat-relating':
      return 'relating';
    case 'private-chat-timeline':
      return 'timeline';
    case 'private-chat-synthesis':
      return 'reasoning';
    default:
      return null;
  }
}

export function stripPrivateChatRequestNoise(question: string): string {
  let text = question.trim();
  text = text.replace(/での/g, ' ');
  const phrases = [...REQUEST_NOISE_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    text = text.replaceAll(phrase, ' ');
  }
  text = text.replace(/[？?。．!！]+$/u, '');
  text = text.replace(/\s*を\s*(?=$|\s)/gu, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function truncateByCodePoint(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export function normalizePrivateChatSearchQuery(value: string): string {
  return truncateByCodePoint(normalizeWhitespace(value), MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiUppercase(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLowercase(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiDigit(code) || isAsciiUppercase(code) || isAsciiLowercase(code);
}

function isPrivateChatAnchorSeparator(code: number): boolean {
  return code === 35 || code === 45 || code === 46 || code === 47 || code === 58 || code === 95;
}

function isPrivateChatAnchorCharacter(code: number): boolean {
  return isAsciiAlphanumeric(code) || isPrivateChatAnchorSeparator(code);
}

function isPrivateChatHashAnchor(token: string): boolean {
  if (token.length < 2 || token.charCodeAt(0) !== 35) {
    return false;
  }
  for (let index = 1; index < token.length; index += 1) {
    if (!isAsciiDigit(token.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

function isPrivateChatStructuredAnchor(token: string): boolean {
  if (
    token.length < 3 ||
    !isAsciiAlphanumeric(token.charCodeAt(0)) ||
    !isAsciiAlphanumeric(token.charCodeAt(token.length - 1))
  ) {
    return false;
  }
  let hasSeparator = false;
  let previousWasSeparator = false;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (isAsciiAlphanumeric(code)) {
      previousWasSeparator = false;
      continue;
    }
    if (!isPrivateChatAnchorSeparator(code) || previousWasSeparator) {
      return false;
    }
    hasSeparator = true;
    previousWasSeparator = true;
  }
  return hasSeparator;
}

function isPrivateChatUppercaseAnchor(token: string): boolean {
  if (token.length < 2) {
    return false;
  }
  let uppercaseCount = 0;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (isAsciiUppercase(code)) {
      uppercaseCount += 1;
      continue;
    }
    if (!isAsciiDigit(code)) {
      return false;
    }
  }
  return uppercaseCount >= 2;
}

export function extractPrivateChatProtectedAnchors(question: string): string[] {
  const seen = new Set<string>();
  const anchors: string[] = [];
  let tokenStart = -1;
  for (let index = 0; index <= question.length; index += 1) {
    const isTokenCharacter =
      index < question.length && isPrivateChatAnchorCharacter(question.charCodeAt(index));
    if (isTokenCharacter) {
      tokenStart = tokenStart < 0 ? index : tokenStart;
      continue;
    }
    if (tokenStart < 0) {
      continue;
    }
    const tokenLength = index - tokenStart;
    if (tokenLength <= 60) {
      const token = question.slice(tokenStart, index);
      const normalized = token.toLowerCase();
      if (
        !seen.has(normalized) &&
        (isPrivateChatHashAnchor(token) ||
          isPrivateChatStructuredAnchor(token) ||
          isPrivateChatUppercaseAnchor(token))
      ) {
        seen.add(normalized);
        anchors.push(token);
      }
    }
    tokenStart = -1;
    if (anchors.length >= 8) {
      break;
    }
  }
  return anchors;
}

function boundedUniqueStrings(
  values: readonly string[],
  options: { readonly maxItems: number; readonly maxLength: number },
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = truncateByCodePoint(normalizeWhitespace(value), options.maxLength);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= options.maxItems) {
      break;
    }
  }
  return result;
}

function isPrivateChatEditingOperation(value: string): value is PrivateChatEditingOperation {
  return (PRIVATE_CHAT_EDITING_OPERATIONS as readonly string[]).includes(value);
}

export function createFallbackPrivateChatQuestionClassification(
  question: string,
): PrivateChatQuestionClassification {
  return {
    confidence: 'low',
    expectedEvidence: [],
    figure: extractPrivateChatProtectedAnchors(question),
    ground: [],
    primaryOperation: 'general',
    secondaryOperations: [],
  };
}

export function sanitizePrivateChatQuestionClassification(
  question: string,
  classification: PrivateChatQuestionClassification,
): PrivateChatQuestionClassification {
  const primaryOperation = isPrivateChatEditingOperation(classification.primaryOperation)
    ? classification.primaryOperation
    : 'general';
  const secondaryOperations = classification.secondaryOperations
    .filter(isPrivateChatEditingOperation)
    .filter(
      (operation, index, values) =>
        operation !== primaryOperation && values.indexOf(operation) === index,
    )
    .slice(0, 2);
  const confidence = ['high', 'medium', 'low'].includes(classification.confidence)
    ? classification.confidence
    : 'low';
  return {
    confidence,
    expectedEvidence: boundedUniqueStrings(classification.expectedEvidence, {
      maxItems: 6,
      maxLength: 60,
    }),
    figure: boundedUniqueStrings(
      [...extractPrivateChatProtectedAnchors(question), ...classification.figure],
      { maxItems: 6, maxLength: 60 },
    ),
    ground: boundedUniqueStrings(classification.ground, { maxItems: 6, maxLength: 60 }),
    primaryOperation,
    secondaryOperations,
  };
}

function buildSimplifiedRetryQuery(stripped: string, primaryQuery: string): string | null {
  const normalized = stripped.replace(/の/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return stripped && stripped !== primaryQuery ? stripped : null;
  }
  const simplified = tokens.slice(0, 2).join(' ').trim();
  return simplified && simplified !== stripped ? simplified : null;
}

/**
 * Builds a safe original-query-only plan. LLM expansion is applied separately and remains optional.
 */
export function buildPrivateChatSearchQueryPlan(question: string): PrivateChatSearchQueryPlan {
  const primaryQuery = normalizePrivateChatSearchQuery(question);
  const stripped = stripPrivateChatRequestNoise(primaryQuery) || primaryQuery;
  const protectedAnchors = extractPrivateChatProtectedAnchors(primaryQuery);
  const simplifiedRetryQuery = buildSimplifiedRetryQuery(stripped, primaryQuery);
  const anchorSafeSimplifiedRetry =
    simplifiedRetryQuery &&
    protectedAnchors.every((anchor) =>
      simplifiedRetryQuery.toLowerCase().includes(anchor.toLowerCase()),
    )
      ? simplifiedRetryQuery
      : null;
  return {
    expandedQueries: [],
    primaryQuery,
    protectedAnchors,
    simplifiedRetryQuery: anchorSafeSimplifiedRetry,
  };
}

export function applyPrivateChatQueryExpansion(
  question: string,
  expansion: PrivateChatQueryExpansion,
): PrivateChatSearchQueryPlan {
  const fallback = buildPrivateChatSearchQueryPlan(question);
  const accepted: PrivateChatExpandedQueryCandidate[] = [];
  const seen = new Set([fallback.primaryQuery.toLowerCase()]);
  for (const candidate of expansion.queries) {
    if (accepted.length >= MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS - 1) {
      break;
    }
    if (containsControlCharacter(candidate.query) || containsControlCharacter(candidate.purpose)) {
      continue;
    }
    const query = normalizeWhitespace(candidate.query);
    if (!query || Array.from(query).length > MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH) {
      continue;
    }
    const key = query.toLowerCase();
    if (seen.has(key) || !isPrivateChatEditingOperation(candidate.operation)) {
      continue;
    }
    if (!fallback.protectedAnchors.every((anchor) => key.includes(anchor.toLowerCase()))) {
      continue;
    }
    const purpose = truncateByCodePoint(normalizeWhitespace(candidate.purpose), 80);
    if (!purpose) {
      continue;
    }
    seen.add(key);
    accepted.push({ operation: candidate.operation, purpose, query });
  }
  return { ...fallback, expandedQueries: accepted };
}

/** @deprecated Use buildPrivateChatSearchQueryPlan for new code. */
export function buildPrivateChatSearchQueries(question: string): string[] {
  const plan = buildPrivateChatSearchQueryPlan(question);
  return [plan.primaryQuery, ...plan.expandedQueries.map((candidate) => candidate.query)].filter(
    Boolean,
  );
}

export function privateChatSearchStageLabel(stage: PrivateChatSearchStageId): string {
  return PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS[stage].label;
}

export function mergeChatSourcesDeterministically(
  ...sourceGroups: readonly (readonly ChatSource[])[]
): ChatSource[] {
  const seen = new Set<string>();
  const merged: ChatSource[] = [];
  for (const group of sourceGroups) {
    for (const source of group) {
      const key = source.documentId || source.rawDocumentId || source.canonicalUri;
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(source);
    }
  }
  return merged;
}

function scoreForMetric(source: ChatSource, metric: ChatScoreMetric): number | undefined {
  return metric === 'vector_distance' ? source.vectorDistance : source.fusedScore;
}

function validateChatSourceSelectionPolicy(policy: ChatSourceSelectionPolicy): void {
  if (policy.kMin < 0 || policy.kMax < 0 || policy.kMin > policy.kMax) {
    throw new Error('Chat source selection policy requires 0 <= kMin <= kMax.');
  }
  if (
    (policy.metric === 'vector_distance' && policy.minNormalizedScore !== undefined) ||
    (policy.metric === 'normalized_fused_score' && policy.maxDistance !== undefined)
  ) {
    throw new Error(
      `Chat source selection policy has an incompatible threshold for ${policy.metric}.`,
    );
  }
  if (
    policy.minNormalizedScore !== undefined &&
    (policy.minNormalizedScore < 0 || policy.minNormalizedScore > 1)
  ) {
    throw new Error('minNormalizedScore must be within 0..1.');
  }
  if (policy.relativeWindow !== undefined && policy.relativeWindow < 0) {
    throw new Error('relativeWindow must not be negative.');
  }
  if (policy.gapRatio !== undefined && policy.gapRatio < 0) {
    throw new Error('gapRatio must not be negative.');
  }
}

/**
 * Selects a bounded, deterministic source set from a ranked score profile.
 *
 * Callers must pass `sources` already sorted by the retrieval metric in best-first order
 * (ascending for `vector_distance`, descending for `fused_score`). This function treats
 * `sources[0]` as the best scored entry when present and detects cliffs from consecutive gaps,
 * so unsorted input yields incorrect cutoffs.
 *
 * Sources without the requested retrieval score retain their existing rank and are not filtered by
 * score thresholds. When every source lacks a score, this is the legacy top-k fallback.
 */
export function selectChatSourcesByScoreProfile(
  sources: readonly ChatSource[],
  policy: ChatSourceSelectionPolicy,
): ChatSource[] {
  validateChatSourceSelectionPolicy(policy);
  const boundedSources = sources.slice(0, policy.kMax);
  const scored = boundedSources.filter(
    (source) => scoreForMetric(source, policy.metric) !== undefined,
  );
  if (scored.length === 0) {
    return boundedSources;
  }

  const bestScore = scoreForMetric(scored[0] as ChatSource, policy.metric) as number;
  const passesThreshold = (source: ChatSource): boolean => {
    const score = scoreForMetric(source, policy.metric);
    if (score === undefined) {
      return true;
    }
    if (policy.metric === 'vector_distance') {
      return (
        (policy.maxDistance === undefined || score <= policy.maxDistance) &&
        (policy.relativeWindow === undefined || score <= bestScore + policy.relativeWindow)
      );
    }
    return (
      (policy.minNormalizedScore === undefined || score >= policy.minNormalizedScore) &&
      (policy.relativeWindow === undefined || score >= bestScore - policy.relativeWindow)
    );
  };

  const thresholdedScored = scored.filter(passesThreshold);
  let cutoff = thresholdedScored.length;

  if (policy.gapRatio !== undefined && thresholdedScored.length > policy.kMin) {
    let largestGapRatio = policy.gapRatio;
    let gapCutoff = cutoff;
    for (
      let index = policy.kMin - 1;
      index < Math.min(thresholdedScored.length - 1, policy.kMax - 1);
      index += 1
    ) {
      const current = scoreForMetric(
        thresholdedScored[index] as ChatSource,
        policy.metric,
      ) as number;
      const next = scoreForMetric(
        thresholdedScored[index + 1] as ChatSource,
        policy.metric,
      ) as number;
      const worsening = policy.metric === 'vector_distance' ? next - current : current - next;
      const ratio = worsening / Math.max(Math.abs(current), Number.EPSILON);
      if (ratio > largestGapRatio) {
        largestGapRatio = ratio;
        gapCutoff = index + 1;
      }
    }
    cutoff = gapCutoff;
  }

  // Do not split a score tie at either cutoff boundary.
  while (
    cutoff < thresholdedScored.length &&
    cutoff > 0 &&
    scoreForMetric(thresholdedScored[cutoff] as ChatSource, policy.metric) ===
      scoreForMetric(thresholdedScored[cutoff - 1] as ChatSource, policy.metric)
  ) {
    cutoff += 1;
  }
  const selectedScored = new Set(thresholdedScored.slice(0, cutoff));
  return boundedSources.filter((source) => {
    const score = scoreForMetric(source, policy.metric);
    return score === undefined || selectedScored.has(source);
  });
}

/**
 * Fuses ranked chat source lists without comparing provider-specific raw scores.
 *
 * @param rankings - Ranked source lists with optional relative weights
 * @param limit - Maximum number of fused sources to return
 * @returns Sources ordered by weighted reciprocal rank with deterministic tie-breaking and normalized scores
 */
export function fuseChatSourceRankings(
  rankings: readonly {
    readonly sources: readonly ChatSource[];
    readonly weight?: number;
  }[],
  limit = MAX_MERGED_SOURCES,
): ChatSource[] {
  const theoreticalMaximum = rankings.reduce(
    (total, ranking) => total + reciprocalRankFusionScore(1, ranking.weight ?? 1),
    0,
  );
  const candidates = new Map<
    string,
    {
      firstListIndex: number;
      firstRank: number;
      score: number;
      source: ChatSource;
    }
  >();
  for (const [listIndex, ranking] of rankings.entries()) {
    const seenInList = new Set<string>();
    for (const [rankIndex, source] of ranking.sources.entries()) {
      const key = source.documentId || source.rawDocumentId || source.canonicalUri;
      if (!key || seenInList.has(key)) {
        continue;
      }
      seenInList.add(key);
      const rank = rankIndex + 1;
      const contribution = reciprocalRankFusionScore(rank, ranking.weight ?? 1);
      const existing = candidates.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        candidates.set(key, {
          firstListIndex: listIndex,
          firstRank: rank,
          score: contribution,
          source,
        });
      }
    }
  }
  return [...candidates.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.score - left.score ||
        left.firstListIndex - right.firstListIndex ||
        left.firstRank - right.firstRank ||
        (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
    .map(([, candidate]) => ({
      ...candidate.source,
      fusedScore: theoreticalMaximum === 0 ? 0 : candidate.score / theoreticalMaximum,
    }));
}

export function mergeChatToolCallsDeterministically(
  ...toolCallGroups: readonly (readonly ChatToolCall[])[]
): ChatToolCall[] {
  const merged = new Map<ChatToolCall['name'], number>();
  for (const group of toolCallGroups) {
    for (const toolCall of group) {
      merged.set(toolCall.name, (merged.get(toolCall.name) ?? 0) + toolCall.resultCount);
    }
  }
  return [...merged.entries()].map(([name, resultCount]) => ({ name, resultCount }));
}

export function formatPrivateChatRetrievalContext(sources: readonly ChatSource[]): string {
  return JSON.stringify(
    {
      note:
        sources.length === 0
          ? 'Workflow 検索では参照 source が見つかりませんでした。追加確認なしに未確認の事実を述べないでください。'
          : 'Workflow が取得した回答根拠候補です。',
      sources: sources.map((source) => ({
        canonicalUri: source.canonicalUri || null,
        documentId: source.documentId,
        docType: source.docType,
        rawDocumentId: source.rawDocumentId,
        snippet: source.snippet ?? null,
        title: source.title,
      })),
      trust: 'untrusted_external_content',
    },
    null,
    2,
  )
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

export interface PrivateChatSearchWorkflowState {
  readonly classification: PrivateChatQuestionClassification;
  readonly detailSources: readonly ChatSource[];
  readonly editing: ChatEditingMetadata;
  readonly graphName: string | null;
  readonly graphSources: readonly ChatSource[];
  readonly mergedVectorSources: readonly ChatSource[];
  readonly plan: PrivateChatSearchQueryPlan;
  readonly projectId: string;
  readonly question: string;
  readonly retrievalContext: string;
  readonly sources: readonly ChatSource[];
  readonly timelineSources: readonly ChatSource[];
  readonly toolCalls: readonly ChatToolCall[];
}

export function runPrivateChatPreparingStep(input: {
  readonly graphName: string | null;
  readonly projectId: string;
  readonly question: string;
}): PrivateChatSearchWorkflowState {
  const editing = inferChatEditingMetadata(input.question);
  const plan = buildPrivateChatSearchQueryPlan(input.question);
  return {
    classification: createFallbackPrivateChatQuestionClassification(input.question),
    detailSources: [],
    editing,
    graphName: input.graphName,
    graphSources: [],
    mergedVectorSources: [],
    plan,
    projectId: input.projectId,
    question: input.question,
    retrievalContext: '',
    sources: [],
    timelineSources: [],
    toolCalls: [],
  };
}

export function applyPrivateChatQuestionClassification(
  state: PrivateChatSearchWorkflowState,
  classification: PrivateChatQuestionClassification,
): PrivateChatSearchWorkflowState {
  return {
    ...state,
    classification: sanitizePrivateChatQuestionClassification(state.question, classification),
  };
}

export function applyPrivateChatWorkflowQueryExpansion(
  state: PrivateChatSearchWorkflowState,
  expansion: PrivateChatQueryExpansion,
): PrivateChatSearchWorkflowState {
  return { ...state, plan: applyPrivateChatQueryExpansion(state.question, expansion) };
}

/** Counts score-qualified vector candidates without treating graph-like unscored sources as evidence. */
export function countSelectedVectorSources(sources: readonly ChatSource[]): number {
  return sources.filter((source) => source.vectorDistance !== undefined).length;
}

export function resolvePrivateChatRetryQueries(
  state: Pick<PrivateChatSearchWorkflowState, 'mergedVectorSources' | 'plan'>,
): readonly string[] {
  const retryQueries = state.plan.expandedQueries.map((candidate) => candidate.query);
  if (
    retryQueries.length === 0 &&
    state.plan.simplifiedRetryQuery &&
    state.plan.simplifiedRetryQuery !== state.plan.primaryQuery &&
    countSelectedVectorSources(state.mergedVectorSources) === 0
  ) {
    retryQueries.push(state.plan.simplifiedRetryQuery);
  }
  return retryQueries;
}

export function shouldRunPrivateChatRetryStep(
  state: Pick<PrivateChatSearchWorkflowState, 'mergedVectorSources' | 'plan'>,
): boolean {
  return resolvePrivateChatRetryQueries(state).length > 0;
}

export function shouldRunPrivateChatTimelineStep(
  state: Pick<PrivateChatSearchWorkflowState, 'classification' | 'editing'>,
): boolean {
  return (
    state.classification.primaryOperation === 'timeline' ||
    state.classification.secondaryOperations.includes('timeline') ||
    state.editing.inferredMode === 'timeline'
  );
}

/**
 * Runs the primary private-chat retrieval with a query vector from the indexed embedding space.
 *
 * @param state - Prepared workflow state containing the primary query
 * @param repository - Project-scoped chat retrieval repository
 * @param embeddingProvider - Provider matching the indexed document embedding model and dimensions
 * @returns Workflow state containing the primary ranked sources
 */
export async function runPrivateChatRetrievingStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
  embeddingProvider: ChatEmbeddingProvider,
): Promise<PrivateChatSearchWorkflowState> {
  const [embedding] = await embedPrivateChatQueries(embeddingProvider, [state.plan.primaryQuery]);
  if (!embedding) {
    throw new Error('Private chat primary query embedding is unavailable.');
  }
  const primaryVectorSources = selectChatSourcesByScoreProfile(
    await repository.vectorSearch({
      embedding,
      embeddingModel: embeddingProvider.model,
      limit: PRIMARY_VECTOR_LIMIT,
      projectId: state.projectId,
      query: state.plan.primaryQuery,
    }),
    primaryVectorSelectionPolicyForModel(embeddingProvider.model),
  );
  return {
    ...state,
    mergedVectorSources: primaryVectorSources,
    toolCalls: mergeChatToolCallsDeterministically(state.toolCalls, [
      { name: 'vector-search', resultCount: primaryVectorSources.length },
    ]),
  };
}

/**
 * Embeds retry queries as one batch and fuses their ranked results with the primary ranking.
 *
 * @param state - Workflow state containing primary results and bounded retry queries
 * @param repository - Project-scoped chat retrieval repository
 * @param embeddingProvider - Provider matching the indexed document embedding model and dimensions
 * @returns Workflow state containing weighted RRF results across query variants
 */
export async function runPrivateChatRetryingStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
  embeddingProvider: ChatEmbeddingProvider,
): Promise<PrivateChatSearchWorkflowState> {
  const toolCalls = [...state.toolCalls];
  const retryQueries = resolvePrivateChatRetryQueries(state);
  const retryEmbeddings = await embedPrivateChatQueries(embeddingProvider, retryQueries);
  const retrySourceGroups = await Promise.all(
    retryQueries.map((retryQuery, index) => {
      const embedding = retryEmbeddings[index];
      if (!embedding) {
        throw new Error(`Private chat retry query embedding is unavailable at index ${index}.`);
      }
      return repository.vectorSearch({
        embedding,
        embeddingModel: embeddingProvider.model,
        limit: PRIMARY_VECTOR_LIMIT,
        projectId: state.projectId,
        query: retryQuery,
      });
    }),
  );
  for (const retrySources of retrySourceGroups) {
    toolCalls.push({ name: 'vector-search', resultCount: retrySources.length });
  }
  const mergedVectorSources = selectChatSourcesByScoreProfile(
    fuseChatSourceRankings(
      [
        { sources: state.mergedVectorSources, weight: PRIMARY_QUERY_RRF_WEIGHT },
        ...retrySourceGroups.map((sources) => ({ sources })),
      ],
      PRIMARY_VECTOR_LIMIT,
    ),
    FUSED_SOURCE_SELECTION_POLICY,
  );
  return {
    ...state,
    mergedVectorSources,
    toolCalls: mergeChatToolCallsDeterministically(toolCalls),
  };
}

export async function runPrivateChatRelatingStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
): Promise<PrivateChatSearchWorkflowState> {
  const graphSources = await repository.graphQuery({
    graphName: state.graphName,
    limit: GRAPH_LIMIT,
    projectId: state.projectId,
    query: state.question,
    seedDocumentIds: state.mergedVectorSources.map((source) => source.documentId),
  });
  return {
    ...state,
    graphSources,
    toolCalls: mergeChatToolCallsDeterministically(state.toolCalls, [
      { name: 'graph-query', resultCount: graphSources.length },
    ]),
  };
}

export async function runPrivateChatTimelineStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
): Promise<PrivateChatSearchWorkflowState> {
  const timelineSources = await repository.timelineSearch({
    limit: TIMELINE_LIMIT,
    projectId: state.projectId,
    query: state.question,
  });
  return {
    ...state,
    timelineSources,
    toolCalls: mergeChatToolCallsDeterministically(state.toolCalls, [
      { name: 'timeline-search', resultCount: timelineSources.length },
    ]),
  };
}

export async function runPrivateChatDetailStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
): Promise<PrivateChatSearchWorkflowState> {
  const detailDocumentIds = mergeChatSourcesDeterministically(
    state.mergedVectorSources,
    state.graphSources,
    state.timelineSources,
  )
    .slice(0, DETAIL_DOCUMENT_LIMIT)
    .map((source) => source.documentId)
    .filter((documentId) => documentId.trim().length > 0);

  const detailSources =
    detailDocumentIds.length > 0
      ? await repository.documentFetch({
          documentIds: detailDocumentIds,
          projectId: state.projectId,
        })
      : [];

  const sources = mergeChatSourcesDeterministically(
    detailSources,
    state.editing.inferredMode === 'timeline' ? state.timelineSources : [],
    state.mergedVectorSources,
    state.graphSources,
  ).slice(0, MAX_MERGED_SOURCES);

  return {
    ...state,
    detailSources,
    retrievalContext: formatPrivateChatRetrievalContext(sources),
    sources,
    toolCalls: mergeChatToolCallsDeterministically(state.toolCalls, [
      { name: 'document-fetch', resultCount: detailSources.length },
    ]),
  };
}

/**
 * Runs bounded private-chat retrieval with model-aligned embeddings and deterministic fusion.
 *
 * @param input - Authorized project scope, query embedding provider, repository, and optional progress callback
 * @returns Editing metadata, untrusted retrieval context, selected sources, and tool summaries
 */
export async function runPrivateChatSearchRetrieval(
  input: PrivateChatSearchRetrievalInput,
): Promise<PrivateChatSearchRetrievalResult> {
  const emit = (stage: PrivateChatSearchStageId) => {
    input.onStage?.(stage);
  };

  emit('preparing');
  let state = runPrivateChatPreparingStep({
    graphName: input.graphName,
    projectId: input.projectId,
    question: input.question,
  });

  emit('retrieving');
  state = await runPrivateChatRetrievingStep(state, input.repository, input.embeddingProvider);

  if (shouldRunPrivateChatRetryStep(state)) {
    emit('retrying');
    state = await runPrivateChatRetryingStep(state, input.repository, input.embeddingProvider);
  }

  emit('relating');
  state = await runPrivateChatRelatingStep(state, input.repository);

  if (shouldRunPrivateChatTimelineStep(state)) {
    emit('timeline');
    state = await runPrivateChatTimelineStep(state, input.repository);
  }

  state = await runPrivateChatDetailStep(state, input.repository);

  return {
    editing: state.editing,
    retrievalContext: state.retrievalContext,
    sources: state.sources,
    toolCalls: state.toolCalls,
  };
}
