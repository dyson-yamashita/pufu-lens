import type { ChatResponse } from './chat.ts';
import {
  type PrivateChatSearchStageId,
  privateChatSearchStageLabel,
} from './private-chat-search.ts';

export type PrivateChatSearchProgressEvent = {
  readonly label: string;
  readonly stage: PrivateChatSearchStageId;
  readonly type: 'progress';
};

export type PrivateChatStreamResultEvent = {
  readonly response: ChatResponse;
  readonly type: 'result';
};

export type PrivateChatStreamErrorEvent = {
  readonly code: string;
  readonly message: string;
  readonly type: 'error';
};

export type PrivateChatStreamEvent =
  | PrivateChatSearchProgressEvent
  | PrivateChatStreamResultEvent
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

export function encodePrivateChatStreamEvent(event: PrivateChatStreamEvent): string {
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

export async function consumePrivateChatNdjsonStream(
  response: Response,
  onProgress?: (event: PrivateChatSearchProgressEvent) => void,
  options?: { readonly maxBufferBytes?: number },
): Promise<ChatResponse> {
  if (!response.body) {
    throw new Error('Chat stream response has no body.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const maxBufferBytes = options?.maxBufferBytes ?? MAX_PRIVATE_CHAT_NDJSON_STREAM_BUFFER_BYTES;
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    if (encoder.encode(buffer).byteLength > maxBufferBytes) {
      throw new Error(PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE);
    }
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
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
        return event.response;
      }
      throw new Error(event.message);
    }
  }
  buffer += decoder.decode();
  if (encoder.encode(buffer).byteLength > maxBufferBytes) {
    throw new Error(PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE);
  }
  const trailing = parsePrivateChatStreamLine(buffer);
  if (trailing?.type === 'result') {
    return trailing.response;
  }
  if (trailing?.type === 'error') {
    throw new Error(trailing.message);
  }
  throw new Error('Chat stream ended without a result.');
}
