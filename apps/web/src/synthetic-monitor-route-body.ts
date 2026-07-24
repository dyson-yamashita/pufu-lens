import {
  SYNTHETIC_MONITOR_MAX_BODY_BYTES,
  SyntheticMonitorRequestError,
} from './synthetic-monitor-contract.ts';

/**
 * Reads a request body stream with a hard byte limit.
 *
 * @param input - Raw body stream, optional Content-Length header, and max bytes.
 * @returns UTF-8 body text and measured byte length.
 */
export async function readBoundedRequestBody(input: {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly contentLength: string | null;
  readonly maxBytes?: number;
}): Promise<{ readonly bytes: number; readonly text: string }> {
  const maxBytes = input.maxBytes ?? SYNTHETIC_MONITOR_MAX_BODY_BYTES;
  if (input.contentLength) {
    const declaredLength = Number(input.contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new SyntheticMonitorRequestError('request body exceeds 64KiB limit.');
    }
  }
  if (!input.body) {
    return { bytes: 0, text: '' };
  }
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SyntheticMonitorRequestError('request body exceeds 64KiB limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { bytes: buffer.length, text: buffer.toString('utf8') };
}

/**
 * Parses a bounded request body string as JSON.
 *
 * @param text - Raw request body text.
 * @returns Parsed JSON value. Empty bodies become `{}`.
 */
export function parseSyntheticMonitorJsonBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SyntheticMonitorRequestError('request body must be valid JSON.');
  }
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * @param headerValue - Raw Authorization header value.
 * @returns Bearer token string, or an empty string when absent.
 */
export function readSyntheticMonitorBearerToken(headerValue: string | null): string {
  const header = headerValue?.trim() ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}
