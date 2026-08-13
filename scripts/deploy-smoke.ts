import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseCanonicalOrigin } from '../packages/activitypub/src/canonical-origin.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const REMOTE_SMOKE_REQUIRED_ENV = [
  'MASTRA_SERVER_URL',
  'SCHEDULER_SERVICE_ACCOUNT',
  'ACTIVITYPUB_CANONICAL_ORIGIN',
] as const;

const VALID_PUBLIC_ACTOR_TYPES = new Set([
  'Service',
  'Application',
  'Group',
  'Organization',
  'Person',
]);

export type DeploySmokeFetch = typeof fetch;

export type RemoteSmokeEnvName = (typeof REMOTE_SMOKE_REQUIRED_ENV)[number];

export type RemoteSmokeCheckId = 'env' | 'webfinger' | 'aggregate_actor';

export type RemoteSmokeCheckResult = {
  readonly id: RemoteSmokeCheckId;
  readonly status: 'passed' | 'failed';
  readonly reason?: string;
  readonly httpStatus?: number;
};

export type RemoteSmokeResult = {
  readonly checkedAt: string;
  readonly env: 'production' | 'staging';
  readonly mode: 'remote_smoke';
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly checks: readonly RemoteSmokeCheckResult[];
  readonly missing?: readonly string[];
};

type WebFingerDocument = {
  readonly subject?: unknown;
  readonly links?: unknown;
};

type ActorDocument = {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly preferredUsername?: unknown;
};

/**
 * Lists required remote smoke environment variables that are missing or blank.
 */
export function listMissingRemoteSmokeEnv(
  envVars: Partial<Record<RemoteSmokeEnvName, string | undefined>>,
): string[] {
  return REMOTE_SMOKE_REQUIRED_ENV.filter((name) => !envVars[name]?.trim());
}

/**
 * Parses deploy smoke CLI options for local dry-run or remote federation checks.
 */
export function parseDeploySmokeArgs(argv: readonly string[]): {
  env: 'production' | 'staging';
  local: boolean;
} {
  let env: 'production' | 'staging' | undefined;
  let local = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--local') {
      local = true;
    } else if (arg === '--env') {
      const value = argv[++index];
      if (value !== 'staging' && value !== 'production') {
        throw new Error('--env must be staging or production.');
      }
      env = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { env: env ?? 'staging', local };
}

/**
 * Runs read-only ActivityPub federation smoke checks against the public canonical origin.
 * Uses GET-only requests and never performs writes, dispatcher triggers, or external delivery.
 */
export async function runRemoteDeploySmoke(input: {
  env: 'production' | 'staging';
  envVars: Partial<Record<RemoteSmokeEnvName, string | undefined>>;
  fetchImpl?: DeploySmokeFetch;
  timeoutMs?: number;
}): Promise<RemoteSmokeResult> {
  const checkedAt = new Date().toISOString();
  const missing = listMissingRemoteSmokeEnv(input.envVars);
  if (missing.length > 0) {
    return {
      checkedAt,
      env: input.env,
      mode: 'remote_smoke',
      status: 'blocked',
      missing,
      checks: [],
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checks: RemoteSmokeCheckResult[] = [];

  const canonicalOrigin = input.envVars.ACTIVITYPUB_CANONICAL_ORIGIN?.trim();
  if (!canonicalOrigin) {
    return {
      checkedAt,
      env: input.env,
      mode: 'remote_smoke',
      status: 'blocked',
      missing: ['ACTIVITYPUB_CANONICAL_ORIGIN'],
      checks: [],
    };
  }

  let origin: string;
  let host: string;
  try {
    ({ origin, host } = parseCanonicalOrigin(canonicalOrigin));
  } catch {
    checks.push({
      id: 'env',
      status: 'failed',
      reason: 'invalid_canonical_origin',
    });
    return {
      checkedAt,
      env: input.env,
      mode: 'remote_smoke',
      status: 'failed',
      checks,
    };
  }

  const expectedSubject = `acct:all@${host}`;
  const expectedActorUrl = `${origin}/activitypub/actors/all`;
  const webfingerUrl = `${origin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;

  const webfingerFetch = await safeFetchWithTimeout(fetchImpl, webfingerUrl, timeoutMs);
  if (webfingerFetch.status === 'failed') {
    checks.push({
      id: 'webfinger',
      status: 'failed',
      reason: webfingerFetch.reason,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }
  const webfingerResponse = webfingerFetch.response;
  if (webfingerResponse.status !== 200) {
    checks.push({
      id: 'webfinger',
      status: 'failed',
      reason: 'unexpected_status',
      httpStatus: webfingerResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  let webfinger: WebFingerDocument;
  try {
    webfinger = (await webfingerResponse.json()) as WebFingerDocument;
  } catch {
    checks.push({
      id: 'webfinger',
      status: 'failed',
      reason: 'invalid_json',
      httpStatus: webfingerResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  if (webfinger.subject !== expectedSubject) {
    checks.push({
      id: 'webfinger',
      status: 'failed',
      reason: 'subject_mismatch',
      httpStatus: webfingerResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  const selfHref = findWebFingerSelfHref(webfinger.links);
  if (!selfHref || selfHref !== expectedActorUrl) {
    checks.push({
      id: 'webfinger',
      status: 'failed',
      reason: 'self_link_mismatch',
      httpStatus: webfingerResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  checks.push({
    id: 'webfinger',
    status: 'passed',
    httpStatus: webfingerResponse.status,
  });

  const actorFetch = await safeFetchWithTimeout(fetchImpl, expectedActorUrl, timeoutMs, {
    accept: 'application/activity+json',
  });
  if (actorFetch.status === 'failed') {
    checks.push({
      id: 'aggregate_actor',
      status: 'failed',
      reason: actorFetch.reason,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }
  const actorResponse = actorFetch.response;
  if (actorResponse.status !== 200) {
    checks.push({
      id: 'aggregate_actor',
      status: 'failed',
      reason: 'unexpected_status',
      httpStatus: actorResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  let actor: ActorDocument;
  try {
    actor = (await actorResponse.json()) as ActorDocument;
  } catch {
    checks.push({
      id: 'aggregate_actor',
      status: 'failed',
      reason: 'invalid_json',
      httpStatus: actorResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  if (actor.id !== expectedActorUrl) {
    checks.push({
      id: 'aggregate_actor',
      status: 'failed',
      reason: 'id_mismatch',
      httpStatus: actorResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  if (actor.preferredUsername !== 'all') {
    checks.push({
      id: 'aggregate_actor',
      status: 'failed',
      reason: 'preferred_username_mismatch',
      httpStatus: actorResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  if (!isValidPublicActorType(actor.type)) {
    checks.push({
      id: 'aggregate_actor',
      status: 'failed',
      reason: 'invalid_actor_type',
      httpStatus: actorResponse.status,
    });
    return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
  }

  checks.push({
    id: 'aggregate_actor',
    status: 'passed',
    httpStatus: actorResponse.status,
  });

  return finalizeRemoteSmokeResult(checkedAt, input.env, checks);
}

async function main(): Promise<void> {
  const options = parseDeploySmokeArgs(process.argv.slice(2));
  if (options.local) {
    await runLocalSmoke();
    return;
  }

  const result = await runRemoteDeploySmoke({
    env: options.env,
    envVars: {
      MASTRA_SERVER_URL: process.env.MASTRA_SERVER_URL,
      SCHEDULER_SERVICE_ACCOUNT: process.env.SCHEDULER_SERVICE_ACCOUNT,
      ACTIVITYPUB_CANONICAL_ORIGIN: process.env.ACTIVITYPUB_CANONICAL_ORIGIN,
    },
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'passed') {
    process.exitCode = 1;
  }
}

async function runLocalSmoke(): Promise<void> {
  const child = spawn(process.execPath, [...process.execArgv, 'scripts/deploy-dry-run.ts'], {
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`local deploy smoke failed with exit code ${exitCode ?? '<unknown>'}`);
  }
}

function finalizeRemoteSmokeResult(
  checkedAt: string,
  env: 'production' | 'staging',
  checks: RemoteSmokeCheckResult[],
): RemoteSmokeResult {
  const failed = checks.some((check) => check.status === 'failed');
  return {
    checkedAt,
    env,
    mode: 'remote_smoke',
    status: failed ? 'failed' : 'passed',
    checks,
  };
}

type SafeFetchResult =
  | { readonly status: 'ok'; readonly response: Response }
  | {
      readonly status: 'failed';
      readonly reason: 'request_timeout' | 'network_error';
    };

async function safeFetchWithTimeout(
  fetchImpl: DeploySmokeFetch,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<SafeFetchResult> {
  try {
    const response = await fetchWithTimeout(fetchImpl, url, timeoutMs, headers);
    return { status: 'ok', response };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'request_timeout') {
      return { status: 'failed', reason: 'request_timeout' };
    }
    return { status: 'failed', reason: 'network_error' };
  }
}

async function fetchWithTimeout(
  fetchImpl: DeploySmokeFetch,
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('request_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findWebFingerSelfHref(links: unknown): string | null {
  if (!Array.isArray(links)) {
    return null;
  }
  for (const link of links) {
    if (!link || typeof link !== 'object') {
      continue;
    }
    const record = link as Record<string, unknown>;
    if (record.rel !== 'self') {
      continue;
    }
    if (
      record.type !== 'application/activity+json' &&
      record.type !== 'application/ld+json' &&
      record.type !== undefined
    ) {
      continue;
    }
    if (typeof record.href !== 'string') {
      continue;
    }
    return record.href;
  }
  return null;
}

function isValidPublicActorType(type: unknown): boolean {
  if (typeof type === 'string') {
    return VALID_PUBLIC_ACTOR_TYPES.has(type);
  }
  if (Array.isArray(type)) {
    return type.some((value) => typeof value === 'string' && VALID_PUBLIC_ACTOR_TYPES.has(value));
  }
  return false;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown): void => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
