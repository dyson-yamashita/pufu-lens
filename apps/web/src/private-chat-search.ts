import {
  type ChatEditingMetadata,
  type ChatRepository,
  type ChatSource,
  type ChatToolCall,
  deterministicVector,
  inferChatEditingMetadata,
  PRIVATE_CHAT_VECTOR_DIMENSIONS,
} from './chat.ts';

export const PRIVATE_CHAT_SEARCH_STAGE_DEFINITIONS = {
  preparing: { id: 'preparing', label: '検索条件を準備しています' },
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
  readonly graphName: string | null;
  readonly onStage?: (stage: PrivateChatSearchStageId) => void;
  readonly projectId: string;
  readonly question: string;
  readonly repository: ChatRepository;
}

const PRIMARY_VECTOR_LIMIT = 5;
const GRAPH_LIMIT = 5;
const TIMELINE_LIMIT = 5;
const DETAIL_DOCUMENT_LIMIT = 5;
const MAX_MERGED_SOURCES = 5;
export const MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS = 3;

const QUERY_EXPANSION_TRIGGERS = [
  'error',
  'fix',
  'bug',
  'failure',
  'fail',
  'exception',
  'エラー',
  '修正',
  '不具合',
  '失敗',
  '障害',
  'バグ',
] as const;

const QUERY_EXPANSION_SUFFIXES = ['error', 'fix', 'failure', 'エラー', '修正', '不具合'] as const;

const REQUEST_NOISE_PHRASES = [
  '教えてください',
  '教えて下さい',
  '教えてほしい',
  '教えて',
  'ください',
  'について',
  '対応実績',
  '実績',
  '状況',
  'を教えて',
] as const;

export interface PrivateChatSearchQueryPlan {
  readonly primaryQuery: string;
  readonly retryQueries: readonly string[];
  readonly simplifiedRetryQuery: string | null;
}

export function mapWorkflowStepIdToUiStage(stepId: string): PrivateChatSearchStageId | null {
  switch (stepId) {
    case 'private-chat-preparing':
      return 'preparing';
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

function extractEntityToken(stripped: string): string | null {
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const entity = tokens.find((token) => /[a-z0-9][-_.][a-z0-9]/i.test(token));
  return entity ?? null;
}

function detectErrorTrigger(text: string): string | null {
  const lower = text.toLowerCase();
  for (const trigger of QUERY_EXPANSION_TRIGGERS) {
    if (lower.includes(trigger.toLowerCase())) {
      return trigger;
    }
  }
  return null;
}

function buildShortErrorVariants(entity: string, trigger: string): string[] {
  const variants = [`${entity} ${trigger}`.trim()];
  for (const suffix of QUERY_EXPANSION_SUFFIXES) {
    if (variants.length >= MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS) {
      break;
    }
    if (
      trigger.toLowerCase() === suffix.toLowerCase() ||
      variants.some((variant) => variant.toLowerCase().includes(suffix.toLowerCase()))
    ) {
      continue;
    }
    const candidate = `${entity} ${suffix}`.trim();
    if (!variants.includes(candidate)) {
      variants.push(candidate);
    }
  }
  return variants.slice(0, MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS);
}

function buildSimplifiedRetryQuery(stripped: string): string | null {
  const normalized = stripped.replace(/の/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return null;
  }
  const simplified = tokens.slice(0, 2).join(' ').trim();
  return simplified && simplified !== stripped && simplified !== normalized ? simplified : null;
}

/**
 * Builds bounded shorter search query variants for hybrid retrieval.
 */
export function buildPrivateChatSearchQueryPlan(question: string): PrivateChatSearchQueryPlan {
  const stripped = stripPrivateChatRequestNoise(question) || question.trim();
  if (!stripped) {
    return { primaryQuery: '', retryQueries: [], simplifiedRetryQuery: null };
  }

  const trigger = detectErrorTrigger(stripped);
  const entity = extractEntityToken(stripped);
  if (trigger && entity) {
    const variants = buildShortErrorVariants(entity, trigger);
    return {
      primaryQuery: variants[0] ?? `${entity} ${trigger}`.trim(),
      retryQueries: variants.slice(1),
      simplifiedRetryQuery: null,
    };
  }

  if (trigger) {
    const tokens = stripped
      .split(/\s+/)
      .filter(
        (token) =>
          !QUERY_EXPANSION_TRIGGERS.some((item) => item.toLowerCase() === token.toLowerCase()),
      );
    const head = tokens.slice(0, 2).join(' ').trim() || stripped;
    const variants = buildShortErrorVariants(head, trigger);
    return {
      primaryQuery: variants[0] ?? stripped,
      retryQueries: variants.slice(1),
      simplifiedRetryQuery: null,
    };
  }

  return {
    primaryQuery: stripped,
    retryQueries: [],
    simplifiedRetryQuery: buildSimplifiedRetryQuery(stripped),
  };
}

/** @deprecated Use buildPrivateChatSearchQueryPlan for new code. */
export function buildPrivateChatSearchQueries(question: string): string[] {
  const plan = buildPrivateChatSearchQueryPlan(question);
  return [plan.primaryQuery, ...plan.retryQueries].filter(Boolean);
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

export function resolvePrivateChatRetryQueries(
  state: Pick<PrivateChatSearchWorkflowState, 'mergedVectorSources' | 'plan'>,
): readonly string[] {
  const retryQueries = [...state.plan.retryQueries];
  if (
    retryQueries.length === 0 &&
    state.plan.simplifiedRetryQuery &&
    state.plan.simplifiedRetryQuery !== state.plan.primaryQuery &&
    state.mergedVectorSources.length === 0
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
  state: Pick<PrivateChatSearchWorkflowState, 'editing'>,
): boolean {
  return state.editing.inferredMode === 'timeline';
}

export async function runPrivateChatRetrievingStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
): Promise<PrivateChatSearchWorkflowState> {
  const primaryVectorSources = await repository.vectorSearch({
    embedding: deterministicVector(state.plan.primaryQuery, PRIVATE_CHAT_VECTOR_DIMENSIONS),
    limit: PRIMARY_VECTOR_LIMIT,
    projectId: state.projectId,
    query: state.plan.primaryQuery,
  });
  return {
    ...state,
    mergedVectorSources: primaryVectorSources,
    toolCalls: mergeChatToolCallsDeterministically(state.toolCalls, [
      { name: 'vector-search', resultCount: primaryVectorSources.length },
    ]),
  };
}

export async function runPrivateChatRetryingStep(
  state: PrivateChatSearchWorkflowState,
  repository: ChatRepository,
): Promise<PrivateChatSearchWorkflowState> {
  let mergedVectorSources = [...state.mergedVectorSources];
  const toolCalls = [...state.toolCalls];
  for (const retryQuery of resolvePrivateChatRetryQueries(state)) {
    const retrySources = await repository.vectorSearch({
      embedding: deterministicVector(retryQuery, PRIVATE_CHAT_VECTOR_DIMENSIONS),
      limit: PRIMARY_VECTOR_LIMIT,
      projectId: state.projectId,
      query: retryQuery,
    });
    toolCalls.push({ name: 'vector-search', resultCount: retrySources.length });
    mergedVectorSources = mergeChatSourcesDeterministically(mergedVectorSources, retrySources);
  }
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
    .map((source) => source.documentId);

  const detailSources =
    detailDocumentIds.length > 0
      ? await repository.documentFetch({
          documentIds: detailDocumentIds,
          projectId: state.projectId,
        })
      : [];

  const sources = mergeChatSourcesDeterministically(
    state.editing.inferredMode === 'timeline' ? state.timelineSources : [],
    state.mergedVectorSources,
    state.graphSources,
    detailSources,
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
  state = await runPrivateChatRetrievingStep(state, input.repository);

  if (shouldRunPrivateChatRetryStep(state)) {
    emit('retrying');
    state = await runPrivateChatRetryingStep(state, input.repository);
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
