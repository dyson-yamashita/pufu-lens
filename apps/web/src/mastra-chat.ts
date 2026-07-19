import type {
  ChatEditingMetadata,
  ChatResponse,
  ChatSource,
  ChatToolCall,
  ChatToolName,
  MastraChatHistoryMessage,
  PublicChatResponse,
  PublicChatSource,
  PublicChatToolCall,
  PublicChatToolName,
} from './chat.ts';
import {
  inferChatEditingMetadata,
  inferPublicChatEditingMetadata,
  privateChatSourcesForResponse,
} from './chat.ts';
import type { ProjectLookupResult, PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';

type FetchHeadersInit = Record<string, string> | Headers;

/**
 * The canonical public project/report chat path proxies to the private Project Chat Agent
 * after the public access gate passes. The legacy public report agent remains available only
 * for compatibility fixtures and direct Mastra regression tests that exercise redacted public
 * report/context-bundle tools.
 */
export const PUBLIC_PROJECT_CHAT_AGENT_ID = 'project-chat-agent';
export const LEGACY_PUBLIC_REPORT_CHAT_AGENT_ID = 'public-report-chat-agent';

type MastraChatEnv = Record<string, string | undefined>;
type MastraIdTokenClient = {
  readonly getRequestHeaders: (url?: string) => Promise<FetchHeadersInit>;
};
type MastraIdTokenClientFactory = (audience: string) => Promise<MastraIdTokenClient>;

const TOOL_NAME_MAP: Record<string, ChatToolName> = {
  documentFetch: 'document-fetch',
  graphQuery: 'graph-query',
  parsedDocFetch: 'parsed-doc-fetch',
  rawDocumentFetch: 'raw-document-fetch',
  timelineSearch: 'timeline-search',
  vectorSearch: 'vector-search',
};

const PUBLIC_TOOL_NAME_MAP: Record<string, PublicChatToolName> = {
  publicContextFetch: 'public-context-fetch',
  publicReportFetch: 'public-report-fetch',
};

interface MastraToolResultContent {
  readonly output?: {
    readonly value?: {
      readonly resultCount?: number;
      readonly sources?: readonly ChatSource[];
      readonly trace?: {
        readonly resultCount?: number;
      };
      readonly view?: unknown;
    };
  };
  readonly toolName?: string;
  readonly type?: string;
}

interface MastraPublicToolResultContent {
  readonly output?: {
    readonly value?: {
      readonly resultCount?: number;
      readonly sources?: readonly PublicChatSource[];
    };
  };
  readonly toolName?: string;
  readonly type?: string;
}

interface MastraPublicGenerateStep {
  readonly content?: readonly MastraPublicToolResultContent[];
}

interface MastraPublicGenerateResponse {
  readonly text?: string;
  readonly steps?: readonly MastraPublicGenerateStep[];
}

interface MastraGenerateStep {
  readonly content?: readonly MastraToolResultContent[];
}

interface MastraGenerateResponse {
  readonly text?: string;
  readonly steps?: readonly MastraGenerateStep[];
}

export function mastraProjectChatGenerateUrl(env: MastraChatEnv = process.env): string {
  return mastraAgentGenerateUrl(PUBLIC_PROJECT_CHAT_AGENT_ID, env);
}

export function mastraPublicReportChatGenerateUrl(env: MastraChatEnv = process.env): string {
  return mastraAgentGenerateUrl(LEGACY_PUBLIC_REPORT_CHAT_AGENT_ID, env);
}

function mastraAgentGenerateUrl(agentId: string, env: MastraChatEnv): string {
  const rawBase = env.MASTRA_SERVER_URL ?? env.MASTRA_API_URL ?? 'http://localhost:4111';
  return `${normalizeMastraUrl(rawBase)}/api/agents/${agentId}/generate`;
}

/**
 * Normalizes a Mastra server base URL by removing trailing slashes and a terminal `/api` suffix.
 *
 * @param rawBase - The configured Mastra server or API base URL
 * @returns A linear-time normalized base URL suitable for appending Mastra paths
 */
export function normalizeMastraUrl(rawBase: string): string {
  return stripTerminalApiSuffix(stripTrailingSlashes(rawBase));
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function stripTerminalApiSuffix(value: string): string {
  if (value.endsWith('/api')) {
    return value.slice(0, -4);
  }
  return value;
}

export async function mastraFetchHeaders(input: {
  readonly authClientFactory?: MastraIdTokenClientFactory;
  readonly env?: MastraChatEnv;
  readonly url: string;
}): Promise<Headers> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (!shouldAttachMastraIdToken(input.url, input.env ?? process.env)) {
    return headers;
  }

  const authClient = await (input.authClientFactory ?? createGoogleAuthIdTokenClient)(
    mastraAuthAudience(input.url),
  );
  const authHeaders = await authClient.getRequestHeaders(input.url);
  for (const [key, value] of new Headers(authHeaders)) {
    headers.set(key, value);
  }
  headers.set('content-type', 'application/json');
  return headers;
}

export function createMastraProjectChatBody(input: {
  readonly graphName?: string | null;
  readonly history?: readonly MastraChatHistoryMessage[];
  readonly projectId: string;
  readonly question: string;
  readonly retrievalContext?: string;
  readonly workflowSources?: readonly ChatSource[];
  readonly workflowToolCalls?: readonly ChatToolCall[];
}) {
  const editing = inferChatEditingMetadata(input.question);
  const history = input.history ?? [];
  return {
    messages: [...history, { content: input.question, role: 'user' as const }],
    requestContext: {
      editing,
      graphName: input.graphName ?? null,
      projectId: input.projectId,
      ...(input.retrievalContext ? { retrievalContext: input.retrievalContext } : {}),
      ...(input.workflowSources ? { workflowSources: input.workflowSources } : {}),
      ...(input.workflowToolCalls ? { workflowToolCalls: input.workflowToolCalls } : {}),
    },
  };
}

export function createPublicProjectChatMastraBody(input: {
  readonly project: Pick<ProjectLookupResult, 'graphName' | 'id'>;
  readonly question: string;
}) {
  return createMastraProjectChatBody({
    graphName: input.project.graphName,
    projectId: input.project.id,
    question: input.question,
  });
}

export function createMastraPublicReportChatBody(input: {
  readonly contextBundle: PublicContextBundleV1;
  readonly projectSlug: string;
  readonly question: string;
  readonly report: PublicReportJsonV1;
  readonly reportId: string;
}) {
  // Compatibility-only body for the legacy public-report-chat-agent.
  // Current public project/report chat should use createPublicProjectChatMastraBody instead.
  const editing = inferPublicChatEditingMetadata(input.question);
  return {
    messages: [{ content: input.question, role: 'user' }],
    requestContext: {
      contextBundle: input.contextBundle,
      editing,
      projectSlug: input.projectSlug,
      report: input.report,
      reportId: input.reportId,
    },
  };
}

export function mastraGenerateToChatResponse(input: {
  readonly editing?: ChatEditingMetadata;
  readonly mastraResponse: unknown;
  readonly projectSlug: string;
  readonly question?: string;
}): ChatResponse {
  const mastraResponse = asMastraGenerateResponse(input.mastraResponse);
  const toolResults = (mastraResponse.steps ?? [])
    .flatMap((step) => step.content ?? [])
    .filter((content) => content.type === 'tool-result');
  const sources = uniqueSources(toolResults.flatMap((result) => toolResultSources(result))).slice(
    0,
    5,
  );
  return {
    answer: mastraResponse.text ?? '',
    ...(input.editing || input.question
      ? { editing: input.editing ?? inferChatEditingMetadata(input.question ?? '') }
      : {}),
    projectSlug: input.projectSlug,
    sources,
    status: 'answered',
    toolCalls: toolResults
      .map((result): ChatToolCall | undefined => {
        const name = result.toolName ? TOOL_NAME_MAP[result.toolName] : undefined;
        if (!name) {
          return undefined;
        }
        return {
          name,
          resultCount:
            result.output?.value?.resultCount ??
            result.output?.value?.trace?.resultCount ??
            result.output?.value?.sources?.length ??
            0,
        };
      })
      .filter((toolCall): toolCall is ChatToolCall => Boolean(toolCall)),
  };
}

export function mergeHybridChatResponse(input: {
  readonly agentResponse: ChatResponse;
  readonly workflowEditing?: ChatEditingMetadata;
  readonly workflowSources: readonly ChatSource[];
  readonly workflowToolCalls: readonly ChatToolCall[];
}): ChatResponse {
  return {
    ...input.agentResponse,
    editing: input.agentResponse.editing ?? input.workflowEditing,
    sources: privateChatSourcesForResponse(
      uniqueSources([...input.workflowSources, ...input.agentResponse.sources]).slice(0, 5),
    ),
    toolCalls: mergeHybridToolCalls(input.workflowToolCalls, input.agentResponse.toolCalls),
  };
}

function mergeHybridToolCalls(
  workflowToolCalls: readonly ChatToolCall[],
  agentToolCalls: readonly ChatToolCall[],
): ChatToolCall[] {
  const merged = new Map<ChatToolName, number>();
  for (const toolCall of [...workflowToolCalls, ...agentToolCalls]) {
    merged.set(toolCall.name, (merged.get(toolCall.name) ?? 0) + toolCall.resultCount);
  }
  return [...merged.entries()].map(([name, resultCount]) => ({ name, resultCount }));
}

export function mastraGenerateToPublicChatResponse(input: {
  readonly editing?: ChatEditingMetadata;
  readonly mastraResponse: unknown;
  readonly projectSlug: string;
  readonly question?: string;
  readonly reportId: string;
}): PublicChatResponse {
  const mastraResponse = asMastraPublicGenerateResponse(input.mastraResponse);
  const toolResults = (mastraResponse.steps ?? [])
    .flatMap((step) => step.content ?? [])
    .filter((content) => content.type === 'tool-result');
  return {
    answer: mastraResponse.text ?? '',
    ...(input.editing || input.question
      ? { editing: input.editing ?? inferPublicChatEditingMetadata(input.question ?? '') }
      : {}),
    projectSlug: input.projectSlug,
    reportId: input.reportId,
    sources: uniquePublicSources(
      toolResults.flatMap((result) => result.output?.value?.sources ?? []),
    ),
    status: 'answered',
    toolCalls: toolResults
      .map((result): PublicChatToolCall | undefined => {
        const name = result.toolName ? PUBLIC_TOOL_NAME_MAP[result.toolName] : undefined;
        if (!name) {
          return undefined;
        }
        return {
          name,
          resultCount:
            result.output?.value?.resultCount ?? result.output?.value?.sources?.length ?? 0,
        };
      })
      .filter((toolCall): toolCall is PublicChatToolCall => Boolean(toolCall)),
  };
}

function asMastraGenerateResponse(value: unknown): MastraGenerateResponse {
  if (!isRecord(value)) {
    return {};
  }
  return {
    steps: parseMastraSteps(value.steps),
    text: typeof value.text === 'string' ? value.text : undefined,
  };
}

function asMastraPublicGenerateResponse(value: unknown): MastraPublicGenerateResponse {
  if (!isRecord(value)) {
    return {};
  }
  return {
    steps: parseMastraPublicSteps(value.steps),
    text: typeof value.text === 'string' ? value.text : undefined,
  };
}

function parseMastraSteps(value: unknown): MastraGenerateStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((step) => ({
    content: isRecord(step) && Array.isArray(step.content) ? step.content : undefined,
  }));
}

function parseMastraPublicSteps(value: unknown): MastraPublicGenerateStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((step) => ({
    content: isRecord(step) && Array.isArray(step.content) ? step.content : undefined,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toolResultSources(result: MastraToolResultContent): ChatSource[] {
  const explicitSources = result.output?.value?.sources ?? [];
  const rawReadSource =
    result.toolName === 'rawDocumentFetch'
      ? chatSourceFromRawReadView(result.output?.value?.view)
      : undefined;
  return rawReadSource ? [...explicitSources, rawReadSource] : [...explicitSources];
}

function chatSourceFromRawReadView(value: unknown): ChatSource | undefined {
  if (
    !isRecord(value) ||
    value.kind !== 'agent_raw_read_view' ||
    value.trust !== 'untrusted_external_content' ||
    !isRecord(value.data)
  ) {
    return undefined;
  }
  const data = value.data;
  const rawDocumentId = optionalString(data.rawDocumentId);
  const sourceType = optionalString(data.sourceType);
  if (!rawDocumentId || !sourceType) {
    return undefined;
  }
  const documentId = optionalString(data.documentId) ?? rawDocumentId;
  const canonicalUri = optionalString(data.canonicalUri) ?? '';
  const title = optionalString(data.title) ?? optionalString(data.sourceId) ?? documentId;
  return {
    canonicalUri,
    documentId,
    docType: sourceType,
    rawDocumentId,
    title,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function shouldAttachMastraIdToken(url: string, env: MastraChatEnv): boolean {
  if (env.MASTRA_ID_TOKEN_ENABLED === 'false') {
    return false;
  }
  if (env.MASTRA_ID_TOKEN_ENABLED === 'true') {
    return true;
  }

  const parsed = new URL(url);
  return (
    parsed.protocol === 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  );
}

function mastraAuthAudience(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

async function createGoogleAuthIdTokenClient(audience: string): Promise<MastraIdTokenClient> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth();
  return auth.getIdTokenClient(audience);
}

function uniqueSources(sources: readonly ChatSource[]): ChatSource[] {
  const seen = new Set<string>();
  const result: ChatSource[] = [];
  for (const source of sources) {
    const key = source.documentId || source.rawDocumentId || source.canonicalUri;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(source);
  }
  return result;
}

function uniquePublicSources(sources: readonly PublicChatSource[]): PublicChatSource[] {
  const seen = new Set<string>();
  const result: PublicChatSource[] = [];
  for (const source of sources) {
    const key = `${source.sectionId}:${source.publicSourceId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(source);
  }
  return result;
}
