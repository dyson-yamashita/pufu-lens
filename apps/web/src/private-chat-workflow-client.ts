import type { ChatResponse, MastraChatHistoryMessage } from './chat.ts';
import { isChatResponseBody } from './chat.ts';
import { mastraFetchHeaders } from './mastra-chat.ts';
import {
  mapWorkflowStepIdToUiStage,
  type PrivateChatSearchStageId,
} from './private-chat-search.ts';
import { DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT } from './project-chat-settings.ts';

export const PRIVATE_CHAT_SEARCH_WORKFLOW_ID = 'private-chat-search';
export const MASTRA_WORKFLOW_RECORD_SEPARATOR = '\x1e';
export const MAX_MASTRA_WORKFLOW_STREAM_BUFFER_BYTES = 256 * 1024;
export const PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE =
  'チャットの処理中にエラーが発生しました。時間をおいて再度お試しください。';

export type PrivateChatWorkflowFailureReason =
  | 'create_run_http_error'
  | 'malformed_or_oversized_stream'
  | 'missing_chat_response'
  | 'missing_run_id'
  | 'missing_stream_body'
  | 'stream_error_record'
  | 'stream_http_error';

type MastraWorkflowEnv = Record<string, string | undefined>;

export interface MastraWorkflowStreamRecord {
  readonly payload?: {
    readonly id?: string;
    readonly output?: unknown;
    readonly status?: string;
    readonly workflowStatus?: string;
  };
  readonly type?: string;
}

export function mastraApiBase(env: MastraWorkflowEnv = process.env): string {
  const rawBase = env.MASTRA_SERVER_URL ?? env.MASTRA_API_URL ?? 'http://localhost:4111';
  return rawBase.replace(/\/+$/, '').replace(/\/api$/, '');
}

export function mastraPrivateChatSearchCreateRunUrl(env: MastraWorkflowEnv = process.env): string {
  return `${mastraApiBase(env)}/api/workflows/${PRIVATE_CHAT_SEARCH_WORKFLOW_ID}/create-run`;
}

export function mastraPrivateChatSearchStreamUrl(
  runId: string,
  env: MastraWorkflowEnv = process.env,
): string {
  return `${mastraApiBase(env)}/api/workflows/${PRIVATE_CHAT_SEARCH_WORKFLOW_ID}/stream?runId=${encodeURIComponent(runId)}`;
}

/**
 * Builds the Mastra `private-chat-search` workflow stream request body.
 *
 * @param input - Workflow scope, history, question, explicit `nowIso`, and an optional final
 * source-selection limit from 1 to 20; the serialized limit defaults to 5 when omitted
 * @returns JSON body containing `inputData` for the workflow stream endpoint
 */
export function createMastraPrivateChatSearchWorkflowStreamBody(input: {
  readonly graphName: string | null;
  readonly history: readonly MastraChatHistoryMessage[];
  readonly hybridSearchDocumentLimit?: number;
  readonly nowIso: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly question: string;
}): { readonly inputData: Record<string, unknown> } {
  return {
    inputData: {
      graphName: input.graphName,
      history: input.history,
      hybridSearchDocumentLimit:
        input.hybridSearchDocumentLimit ?? DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT,
      nowIso: input.nowIso,
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      question: input.question,
    },
  };
}

export function parseMastraWorkflowStreamBuffer(input: {
  readonly buffer: string;
  readonly maxBufferBytes?: number;
}): { readonly records: readonly MastraWorkflowStreamRecord[]; readonly remainder: string } {
  const maxBufferBytes = input.maxBufferBytes ?? MAX_MASTRA_WORKFLOW_STREAM_BUFFER_BYTES;
  if (Buffer.byteLength(input.buffer, 'utf8') > maxBufferBytes) {
    throw new PrivateChatWorkflowInvocationError(502, 'malformed_or_oversized_stream');
  }

  const parts = input.buffer.split(MASTRA_WORKFLOW_RECORD_SEPARATOR);
  const remainder = parts.pop() ?? '';
  const records: MastraWorkflowStreamRecord[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as MastraWorkflowStreamRecord);
    } catch {}
  }
  return { records, remainder };
}

export function extractChatResponseFromMastraWorkflowRecord(
  record: MastraWorkflowStreamRecord,
): ChatResponse | null {
  if (record.type === 'workflow-step-result' && record.payload?.id === 'private-chat-synthesis') {
    const output = record.payload.output;
    if (isChatResponseBody(output)) {
      return output;
    }
  }
  if (record.type === 'workflow-finish') {
    const output = (record.payload as { readonly output?: unknown } | undefined)?.output;
    if (isChatResponseBody(output)) {
      return output;
    }
  }
  return null;
}

export function mapMastraWorkflowRecordToUiStage(
  record: MastraWorkflowStreamRecord,
): PrivateChatSearchStageId | null {
  if (record.type !== 'workflow-step-start') {
    return null;
  }
  const stepId = record.payload?.id;
  return stepId ? mapWorkflowStepIdToUiStage(stepId) : null;
}

function processMastraWorkflowRecords(
  records: readonly MastraWorkflowStreamRecord[],
  onRecord?: (record: MastraWorkflowStreamRecord) => void,
): ChatResponse | null {
  let finalResponse: ChatResponse | null = null;
  for (const record of records) {
    onRecord?.(record);
    if (record.type === 'error') {
      throw new PrivateChatWorkflowInvocationError(502, 'stream_error_record');
    }
    const response = extractChatResponseFromMastraWorkflowRecord(record);
    if (response) {
      finalResponse = response;
    }
  }
  return finalResponse;
}

function parseTrailingMastraWorkflowRecord(remainder: string): MastraWorkflowStreamRecord | null {
  const trimmed = remainder.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as MastraWorkflowStreamRecord;
  } catch {
    return null;
  }
}

function finalizeMastraWorkflowStreamBuffer(input: {
  readonly buffer: string;
  readonly maxBufferBytes?: number;
  readonly onRecord?: (record: MastraWorkflowStreamRecord) => void;
  readonly finalResponse: ChatResponse | null;
}): ChatResponse | null {
  let finalResponse = input.finalResponse;
  const trailingRecord = parseTrailingMastraWorkflowRecord(input.buffer);
  if (trailingRecord) {
    const trailingResponse = processMastraWorkflowRecords([trailingRecord], input.onRecord);
    if (trailingResponse) {
      finalResponse = trailingResponse;
    }
  }
  return finalResponse;
}

export function consumeMastraWorkflowStreamText(
  text: string,
  onRecord?: (record: MastraWorkflowStreamRecord) => void,
  options?: { readonly maxBufferBytes?: number },
): ChatResponse {
  const parsed = parseMastraWorkflowStreamBuffer({
    buffer: text,
    maxBufferBytes: options?.maxBufferBytes,
  });
  let finalResponse = processMastraWorkflowRecords(parsed.records, onRecord);
  finalResponse = finalizeMastraWorkflowStreamBuffer({
    buffer: parsed.remainder,
    finalResponse,
    maxBufferBytes: options?.maxBufferBytes,
    onRecord,
  });
  if (!finalResponse) {
    throw new PrivateChatWorkflowInvocationError(502, 'missing_chat_response');
  }
  return finalResponse;
}

export async function consumeMastraWorkflowStream(
  body: ReadableStream<Uint8Array>,
  onRecord?: (record: MastraWorkflowStreamRecord) => void,
  options?: { readonly maxBufferBytes?: number },
): Promise<ChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: ChatResponse | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseMastraWorkflowStreamBuffer({
        buffer,
        maxBufferBytes: options?.maxBufferBytes,
      });
      buffer = parsed.remainder;
      const chunkResponse = processMastraWorkflowRecords(parsed.records, onRecord);
      if (chunkResponse) {
        finalResponse = chunkResponse;
      }
    }

    buffer += decoder.decode();
    finalResponse = finalizeMastraWorkflowStreamBuffer({
      buffer,
      finalResponse,
      maxBufferBytes: options?.maxBufferBytes,
      onRecord,
    });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (!finalResponse) {
    throw new PrivateChatWorkflowInvocationError(502, 'missing_chat_response');
  }
  return finalResponse;
}

/**
 * Runs the shared `private-chat-search` Mastra workflow for private and public chat callers.
 *
 * @param input - Project scope, question, optional history, optional deterministic `nowIso`, and
 * an optional final source-selection limit from 1 to 20; the workflow receives 5 when omitted
 * @returns The answered chat response extracted from the workflow stream
 * @throws PrivateChatWorkflowInvocationError When workflow creation, input validation, streaming,
 * or parsing fails; the Mastra workflow schema rejects limits outside 1 to 20
 */
export async function runPrivateChatSearchViaMastraWorkflow(input: {
  readonly env?: MastraWorkflowEnv;
  readonly fetchImpl?: typeof fetch;
  readonly graphName: string | null;
  readonly history: readonly MastraChatHistoryMessage[];
  readonly hybridSearchDocumentLimit?: number;
  readonly nowIso?: string;
  readonly onStage?: (stage: PrivateChatSearchStageId) => void;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly question: string;
  readonly signal?: AbortSignal;
}): Promise<ChatResponse> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const createRunUrl = mastraPrivateChatSearchCreateRunUrl(env);
  const createRunResponse = await fetchImpl(createRunUrl, {
    body: JSON.stringify({}),
    headers: await mastraFetchHeaders({ env, url: createRunUrl }),
    method: 'POST',
    signal: input.signal,
  });
  if (!createRunResponse.ok) {
    await createRunResponse.body?.cancel().catch(() => undefined);
    throw new PrivateChatWorkflowInvocationError(createRunResponse.status, 'create_run_http_error');
  }
  const createRunBody = (await createRunResponse.json().catch(() => ({}))) as { runId?: string };
  if (!createRunBody.runId) {
    throw new PrivateChatWorkflowInvocationError(createRunResponse.status, 'missing_run_id');
  }

  const streamUrl = mastraPrivateChatSearchStreamUrl(createRunBody.runId, env);
  const streamResponse = await fetchImpl(streamUrl, {
    body: JSON.stringify(
      createMastraPrivateChatSearchWorkflowStreamBody({
        graphName: input.graphName,
        history: input.history,
        hybridSearchDocumentLimit: input.hybridSearchDocumentLimit,
        nowIso,
        projectId: input.projectId,
        projectSlug: input.projectSlug,
        question: input.question,
      }),
    ),
    headers: await mastraFetchHeaders({ env, url: streamUrl }),
    method: 'POST',
    signal: input.signal,
  });
  if (!streamResponse.ok) {
    await streamResponse.body?.cancel().catch(() => undefined);
    throw new PrivateChatWorkflowInvocationError(streamResponse.status, 'stream_http_error');
  }
  if (!streamResponse.body) {
    throw new PrivateChatWorkflowInvocationError(502, 'missing_stream_body');
  }

  return consumeMastraWorkflowStream(streamResponse.body, (record) => {
    const stage = mapMastraWorkflowRecordToUiStage(record);
    if (stage) {
      input.onStage?.(stage);
    }
  });
}

export class PrivateChatWorkflowInvocationError extends Error {
  readonly reason: PrivateChatWorkflowFailureReason;
  readonly status: number;

  constructor(status: number, reason: PrivateChatWorkflowFailureReason) {
    super(PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE);
    this.name = 'PrivateChatWorkflowInvocationError';
    this.status = status;
    this.reason = reason;
  }
}

export function privateChatWorkflowSafeLogMessage(error: unknown): string {
  if (isPrivateChatWorkflowAbortError(error)) {
    return '';
  }
  if (error instanceof PrivateChatWorkflowInvocationError) {
    return `Private chat workflow failed: ${error.reason} (HTTP ${error.status})`;
  }
  return 'Private chat workflow failed: unexpected_error';
}

export function logPrivateChatWorkflowFailure(error: unknown): void {
  const message = privateChatWorkflowSafeLogMessage(error);
  if (message) {
    console.error(message);
  }
}

export function isPrivateChatWorkflowAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
