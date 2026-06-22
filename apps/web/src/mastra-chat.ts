import type {
  ChatResponse,
  ChatSource,
  ChatToolCall,
  ChatToolName,
  PublicChatResponse,
  PublicChatSource,
  PublicChatToolCall,
  PublicChatToolName,
} from './chat.ts';
import type { PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';

const PROJECT_CHAT_AGENT_ID = 'project-chat-agent';
const PUBLIC_REPORT_CHAT_AGENT_ID = 'public-report-chat-agent';

type MastraChatEnv = Record<string, string | undefined>;
type MastraIdTokenClient = {
  readonly getRequestHeaders: (url?: string) => Promise<HeadersInit>;
};
type MastraIdTokenClientFactory = (audience: string) => Promise<MastraIdTokenClient>;

const TOOL_NAME_MAP: Record<string, ChatToolName> = {
  documentFetch: 'document-fetch',
  graphQuery: 'graph-query',
  parsedDocFetch: 'parsed-doc-fetch',
  rawDocumentFetch: 'raw-document-fetch',
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
  const rawBase = env.MASTRA_SERVER_URL ?? env.MASTRA_API_URL ?? 'http://localhost:4111';
  const base = rawBase.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/agents/${PROJECT_CHAT_AGENT_ID}/generate`;
}

export function mastraPublicReportChatGenerateUrl(env: MastraChatEnv = process.env): string {
  const rawBase = env.MASTRA_SERVER_URL ?? env.MASTRA_API_URL ?? 'http://localhost:4111';
  const base = rawBase.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/agents/${PUBLIC_REPORT_CHAT_AGENT_ID}/generate`;
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
  readonly projectId: string;
  readonly question: string;
}) {
  return {
    messages: [{ content: input.question, role: 'user' }],
    requestContext: { projectId: input.projectId },
  };
}

export function createMastraPublicReportChatBody(input: {
  readonly contextBundle: PublicContextBundleV1;
  readonly projectSlug: string;
  readonly question: string;
  readonly report: PublicReportJsonV1;
  readonly reportId: string;
}) {
  return {
    messages: [{ content: input.question, role: 'user' }],
    requestContext: {
      contextBundle: input.contextBundle,
      projectSlug: input.projectSlug,
      report: input.report,
      reportId: input.reportId,
    },
  };
}

export function mastraGenerateToChatResponse(input: {
  readonly mastraResponse: unknown;
  readonly projectSlug: string;
}): ChatResponse {
  const mastraResponse = asMastraGenerateResponse(input.mastraResponse);
  const toolResults = (mastraResponse.steps ?? [])
    .flatMap((step) => step.content ?? [])
    .filter((content) => content.type === 'tool-result');
  const sources = uniqueSources(
    toolResults.flatMap((result) => result.output?.value?.sources ?? []),
  ).slice(0, 5);
  return {
    answer: mastraResponse.text ?? '',
    projectSlug: input.projectSlug,
    sources,
    status: 'answered',
    toolCalls: toolResults
      .map((result): ChatToolCall | undefined => {
        const name = result.toolName ? TOOL_NAME_MAP[result.toolName] : undefined;
        if (!name) {
          return undefined;
        }
        return { name, resultCount: result.output?.value?.sources?.length ?? 0 };
      })
      .filter((toolCall): toolCall is ChatToolCall => Boolean(toolCall)),
  };
}

export function mastraGenerateToPublicChatResponse(input: {
  readonly mastraResponse: unknown;
  readonly projectSlug: string;
  readonly reportId: string;
}): PublicChatResponse {
  const mastraResponse = asMastraPublicGenerateResponse(input.mastraResponse);
  const toolResults = (mastraResponse.steps ?? [])
    .flatMap((step) => step.content ?? [])
    .filter((content) => content.type === 'tool-result');
  return {
    answer: mastraResponse.text ?? '',
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
