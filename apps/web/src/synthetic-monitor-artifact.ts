import type { Readable } from 'node:stream';
import { validatePrivateReportJson } from './report-schema.ts';

/**
 * Reads a UTF-8 object stream up to a bounded byte limit.
 *
 * @param stream - Object storage readable stream.
 * @param maxBytes - Maximum allowed bytes before the read is treated as oversize.
 * @returns Read text and whether the stream exceeded the byte limit.
 */
export async function readBoundedUtf8FromStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ readonly exceeded: boolean; readonly text: string }> {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of readable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      if (typeof readable.destroy === 'function') {
        readable.destroy();
      }
      return { exceeded: true, text: '' };
    }
    chunks.push(buffer);
  }
  return { exceeded: false, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Validates private report artifact JSON and checks metadata consistency.
 *
 * @param input - Parsed artifact JSON and expected metadata identifiers.
 * @returns Whether the artifact is consistent with repository metadata.
 */
export function isSyntheticMonitorArtifactConsistent(input: {
  readonly artifact: unknown;
  readonly expectedProjectId: string;
  readonly expectedReportId: string;
  readonly expectedSchemaVersion: string;
}): boolean {
  if (!isRecord(input.artifact)) {
    return false;
  }
  if (
    input.artifact.schema_version !== input.expectedSchemaVersion ||
    input.artifact.report_id !== input.expectedReportId ||
    input.artifact.project_id !== input.expectedProjectId
  ) {
    return false;
  }
  validatePrivateReportJson(input.artifact);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
