import type { ChatResponse, PublicChatResponse } from './chat.ts';
import {
  type PrivateChatSearchStageId,
  privateChatSearchStageLabel,
} from './private-chat-search-stages.ts';

export type PrivateChatSearchProgressEvent = {
  readonly label: string;
  readonly stage: PrivateChatSearchStageId;
  readonly type: 'progress';
};

export type ChatStreamResponse = ChatResponse | PublicChatResponse;

export type PrivateChatStreamResultEvent<ChatResult extends ChatStreamResponse = ChatResponse> = {
  readonly response: ChatResult;
  readonly type: 'result';
};

export type PrivateChatStreamErrorEvent = {
  readonly code: string;
  readonly message: string;
  readonly type: 'error';
};

export type PrivateChatStreamEvent<ChatResult extends ChatStreamResponse = ChatResponse> =
  | PrivateChatSearchProgressEvent
  | PrivateChatStreamResultEvent<ChatResult>
  | PrivateChatStreamErrorEvent;

export const MAX_PRIVATE_CHAT_NDJSON_STREAM_BUFFER_BYTES = 256 * 1024;
export const PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE =
  'チャットの処理中にエラーが発生しました。時間をおいて再度お試しください。';

export function createPrivateChatSearchProgressEvent(
  stage: PrivateChatSearchStageId,
): PrivateChatSearchProgressEvent {
  return {
    label: privateChatSearchStageLabel(stage),
    stage,
    type: 'progress',
  };
}

/**
 * NDJSON 1 行分の stream event をエンコードする。
 *
 * `result.response` の具体的な形状は呼び出し側の `ChatResult` に委ねる。
 * このヘルパーは JSON 化のみを行い、response 形の検証は caller の責務とする。
 */
export function encodePrivateChatStreamEvent<ChatResult extends ChatStreamResponse = ChatResponse>(
  event: PrivateChatStreamEvent<ChatResult>,
): string {
  return `${JSON.stringify(event)}\n`;
}

export function parsePrivateChatStreamLine(line: string): PrivateChatStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as PrivateChatStreamEvent;
    if (
      parsed.type === 'progress' &&
      typeof parsed.stage === 'string' &&
      typeof parsed.label === 'string'
    ) {
      return parsed;
    }
    if (parsed.type === 'result' && parsed.response && typeof parsed.response === 'object') {
      return parsed;
    }
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function clientAcceptsPrivateChatStream(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/x-ndjson') || accept.includes('text/event-stream');
}

/**
 * NDJSON stream を消費し、progress event を `onProgress` へ通知しつつ最終 `result` の
 * `response` を返す。direct な `result` 行と末尾 trailing 行の両方を扱う。
 *
 * `response` の実際の形状は呼び出し側の `ChatResult` に委ねられ、このヘルパーは
 * object であることしか検証しない。caller は返り値を型ガード
 * （例: `isPublicChatResponseBody`）で検証すること。
 */
export async function consumePrivateChatNdjsonStream<
  ChatResult extends ChatStreamResponse = ChatResponse,
>(
  response: Response,
  onProgress?: (event: PrivateChatSearchProgressEvent) => void,
  options?: { readonly maxBufferBytes?: number },
): Promise<ChatResult> {
  if (!response.body) {
    throw new Error('Chat stream response has no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maxBufferBytes = options?.maxBufferBytes ?? MAX_PRIVATE_CHAT_NDJSON_STREAM_BUFFER_BYTES;
  let buffer = '';
  let bufferByteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bufferByteLength += value.byteLength;
      if (bufferByteLength > maxBufferBytes) {
        throw new Error(PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      const lastNewlineByteIndex = value.lastIndexOf(0x0a);
      if (lastNewlineByteIndex >= 0) {
        bufferByteLength = value.byteLength - lastNewlineByteIndex - 1;
      }
      for (const line of lines) {
        const event = parsePrivateChatStreamLine(line);
        if (!event) {
          continue;
        }
        if (event.type === 'progress') {
          onProgress?.(event);
          continue;
        }
        if (event.type === 'result') {
          return event.response as ChatResult;
        }
        throw new Error(event.message);
      }
    }
    buffer += decoder.decode();
    const trailing = parsePrivateChatStreamLine(buffer);
    if (trailing?.type === 'result') {
      return trailing.response as ChatResult;
    }
    if (trailing?.type === 'error') {
      throw new Error(trailing.message);
    }
    throw new Error('Chat stream ended without a result.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
