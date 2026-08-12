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

const DEFAULT_TRACE_ARTIFACT_PATH = resolve(
  fileURLToPath(
    new URL('../../../../artifacts/activitypub-e2e/protocol-trace.json', import.meta.url),
  ),
);

const ALLOWED_TRACE_HOSTS = new Set(['lens-a.test', 'lens-b.test', 'mastodon.test']);
const PUBLIC_AUDIENCE_URI = 'https://www.w3.org/ns/activitystreams#Public';
const REDACTED_HOST = '[redacted-host]';
const REDACTED_PATH = '[redacted-path]';
const REDACTED_ACTIVITY_TYPE = '[redacted-type]';
const REDACTED_URI = '[redacted-uri]';
const REDACTED_METHOD = '[redacted-method]';

const ALLOWED_TRACE_METHODS = new Set(['GET', 'POST']);

const ALLOWED_ACTIVITY_TYPES = new Set([
  'Accept',
  'Add',
  'Announce',
  'Block',
  'Create',
  'Delete',
  'Flag',
  'Follow',
  'Like',
  'Remove',
  'Undo',
  'Update',
]);

const HERMETIC_CONTROL_ACTIONS = new Set([
  'follow',
  'process-dispatcher',
  'process-queue',
  'publish-report',
  'representation',
  'search',
  'state',
  'undo',
]);

/** Collects sanitized ActivityPub protocol events for hermetic E2E artifacts. */
export class ProtocolTraceCollector {
  readonly #entries: ProtocolTraceEntry[] = [];
  readonly #artifactPath: string;

  constructor(artifactPath = DEFAULT_TRACE_ARTIFACT_PATH) {
    this.#artifactPath = artifactPath;
  }

  record(entry: ProtocolTraceEntry): void {
    this.#entries.push(sanitizeProtocolTraceEntry(entry));
  }

  snapshot(): readonly ProtocolTraceEntry[] {
    return [...this.#entries];
  }

  async writeArtifact(): Promise<void> {
    await mkdir(dirname(this.#artifactPath), { recursive: true });
    await writeFile(this.#artifactPath, `${JSON.stringify(this.#entries, null, 2)}\n`, 'utf8');
  }
}

function sanitizeProtocolTraceEntry(entry: ProtocolTraceEntry): ProtocolTraceEntry {
  return {
    method: sanitizeTraceMethod(entry.method),
    host: sanitizeTraceHost(entry.host),
    path: sanitizeTracePath(entry.path),
    status: entry.status,
    activityType:
      entry.activityType === undefined ? undefined : sanitizeTraceActivityType(entry.activityType),
    activityId: entry.activityId === undefined ? undefined : sanitizeTraceUri(entry.activityId),
    signed: entry.signed,
    digestKind: entry.digestKind,
    signatureVerified: entry.signatureVerified,
    keyOwnerUri: entry.keyOwnerUri === undefined ? undefined : sanitizeTraceUri(entry.keyOwnerUri),
    audienceUri: entry.audienceUri === undefined ? undefined : sanitizeTraceUri(entry.audienceUri),
  };
}

function sanitizeTraceMethod(method: string): string {
  return ALLOWED_TRACE_METHODS.has(method) ? method : REDACTED_METHOD;
}

function sanitizeTraceHost(host: string): string {
  return ALLOWED_TRACE_HOSTS.has(host) ? host : REDACTED_HOST;
}

function sanitizeTraceActivityType(activityType: string): string {
  return ALLOWED_ACTIVITY_TYPES.has(activityType) ? activityType : REDACTED_ACTIVITY_TYPE;
}

function sanitizeTraceUri(value: string): string {
  if (value === PUBLIC_AUDIENCE_URI) {
    return value;
  }
  if (containsSensitiveIdentifier(value)) {
    return REDACTED_URI;
  }
  try {
    const parsed = new URL(value);
    if (!ALLOWED_TRACE_HOSTS.has(parsed.hostname)) {
      return REDACTED_URI;
    }
    const sanitizedPath = sanitizeTracePath(parsed.pathname);
    if (sanitizedPath === REDACTED_PATH) {
      return REDACTED_URI;
    }
    parsed.pathname = sanitizedPath;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return REDACTED_URI;
  }
}

function sanitizeTracePath(path: string): string {
  if (path === '/inbox') {
    return '/inbox';
  }
  if (path === '/.well-known/webfinger') {
    return '/.well-known/webfinger';
  }
  if (path === '/activitypub/inbox') {
    return '/activitypub/inbox';
  }
  if (/^\/activitypub\/actors\/[^/]+$/.test(path)) {
    return '/activitypub/actors/:actor';
  }
  if (/^\/activitypub\/actors\/[^/]+\/inbox$/.test(path)) {
    return '/activitypub/actors/:actor/inbox';
  }
  if (/^\/activitypub\/activities\//.test(path)) {
    return '/activitypub/activities/:activity';
  }
  if (/^\/activitypub\/reports\//.test(path)) {
    return '/activitypub/reports/:report';
  }
  if (/^\/users\/[^/]+$/.test(path)) {
    return '/users/:user';
  }
  if (/^\/users\/[^/]+\/inbox$/.test(path)) {
    return '/users/:user/inbox';
  }
  const controlMatch = path.match(/^\/__hermetic__\/([^/]+)$/);
  if (controlMatch && HERMETIC_CONTROL_ACTIONS.has(controlMatch[1] ?? '')) {
    return `/__hermetic__/${controlMatch[1]}`;
  }
  return REDACTED_PATH;
}

function containsSensitiveIdentifier(value: string): boolean {
  if (value.includes('@') && !value.startsWith('acct:')) {
    return true;
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) {
    return true;
  }
  if (/^acct:[^@]+@[^/]+$/i.test(value)) {
    return true;
  }
  return false;
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
  if (headers.has('content-digest')) {
    return 'rfc9421';
  }
  if (headers.has('digest')) {
    return 'legacy';
  }
  return 'none';
}

export {
  PUBLIC_AUDIENCE_URI as PROTOCOL_TRACE_PUBLIC_AUDIENCE_URI,
  REDACTED_ACTIVITY_TYPE,
  REDACTED_HOST,
  REDACTED_METHOD,
  REDACTED_PATH,
  REDACTED_URI,
};
