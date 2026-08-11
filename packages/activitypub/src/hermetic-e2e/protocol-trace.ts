import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProtocolTraceDigestKind = 'legacy' | 'rfc9421' | 'none';

export type ProtocolTraceEntry = {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly activityType?: string;
  readonly activityId?: string;
  readonly signed: boolean;
  readonly digestKind: ProtocolTraceDigestKind;
  readonly signatureVerified?: boolean;
  readonly keyOwnerUri?: string;
  readonly audienceUri?: string;
};

const TRACE_ARTIFACT_PATH = resolve(
  fileURLToPath(
    new URL('../../../../artifacts/activitypub-e2e/protocol-trace.json', import.meta.url),
  ),
);

/** Collects sanitized ActivityPub protocol events for hermetic E2E artifacts. */
export class ProtocolTraceCollector {
  readonly #entries: ProtocolTraceEntry[] = [];

  record(entry: ProtocolTraceEntry): void {
    this.#entries.push(entry);
  }

  snapshot(): readonly ProtocolTraceEntry[] {
    return [...this.#entries];
  }

  async writeArtifact(): Promise<void> {
    await mkdir(dirname(TRACE_ARTIFACT_PATH), { recursive: true });
    await writeFile(TRACE_ARTIFACT_PATH, `${JSON.stringify(this.#entries, null, 2)}\n`, 'utf8');
  }
}

export function readActivityTypeFromJson(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

export function readActivityIdFromJson(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

export function detectDigestKind(headers: Headers): ProtocolTraceDigestKind {
  if (headers.has('content-digest') || headers.has('Content-Digest')) {
    return 'rfc9421';
  }
  if (headers.has('digest') || headers.has('Digest')) {
    return 'legacy';
  }
  return 'none';
}
