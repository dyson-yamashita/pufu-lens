import type postgres from 'postgres';
import type { ActivityPubRepository } from '../actor-repository.ts';
import type { ActivityPubFollowUseCases } from '../follow-use-cases.ts';
import { enqueueReportPublicationOutbox } from '../report-publication-outbox.ts';
import type { ObjectRepresentation } from '../schema.ts';
import { assertActivityPubHermeticE2eRuntime } from '../test-runtime-guard.ts';
import { buildActivityPubUriContract } from '../uri-contract.ts';
import type { HermeticFaultController } from './fault-controller.ts';

const CONTROL_PREFIX = '/__hermetic__/';
const INVALID_CONTROL_REQUEST = { ok: false, error: 'invalid control request' } as const;
const FOLLOW_STATUSES = new Set(['pending', 'accepted', 'rejected', 'undone']);
const QUEUE_STATUSES = new Set([
  'pending',
  'running',
  'retry_wait',
  'succeeded',
  'retry_exhausted',
  'permanent_failure',
]);

export type HermeticControlClient = {
  search(input: { acct: string }): Promise<Response>;
  follow(input: {
    projectSlug: string;
    localActorPreferredUsername: string;
    remoteActorAddress: string;
  }): Promise<Response>;
  undo(input: {
    projectSlug: string;
    localActorPreferredUsername: string;
    remoteActorUri: string;
    remoteInboxUri: string;
    remoteSharedInboxUri?: string | null;
  }): Promise<Response>;
  publishReport(input: {
    reportId: string;
    publicSummary: string;
    publishedAt?: string;
  }): Promise<Response>;
  updateRepresentation(input: { representation: ObjectRepresentation }): Promise<Response>;
  processQueue(input?: { limit?: number }): Promise<Response>;
  processDispatcher(input?: { limit?: number }): Promise<Response>;
  state(): Promise<Response>;
};

/** Creates an HTTP-only control client for one hermetic Pufu Lens instance. */
export function createHermeticControlClient(surface: {
  readonly origin: string;
}): HermeticControlClient {
  return {
    search: (input) => controlFetch(surface, 'search', input),
    follow: (input) => controlFetch(surface, 'follow', input),
    undo: (input) => controlFetch(surface, 'undo', input),
    publishReport: (input) => controlFetch(surface, 'publish-report', input),
    updateRepresentation: (input) => controlFetch(surface, 'representation', input),
    processQueue: (input) => controlFetch(surface, 'process-queue', input ?? {}),
    processDispatcher: (input) => controlFetch(surface, 'process-dispatcher', input ?? {}),
    state: () => controlFetch(surface, 'state', {}),
  };
}

async function controlFetch(
  surface: { readonly origin: string },
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${surface.origin}${CONTROL_PREFIX}${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Handles test-only control routes when hermetic runtime guards pass. */
export async function tryHandleHermeticControlRoute(
  request: Request,
  ctx: HermeticControlContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CONTROL_PREFIX) || request.method !== 'POST') {
    return null;
  }
  assertActivityPubHermeticE2eRuntime();
  const action = url.pathname.slice(CONTROL_PREFIX.length);
  const body = await parseControlBody(request);
  if (body instanceof Response) {
    return body;
  }

  switch (action) {
    case 'search':
      return handleSearch(ctx, body);
    case 'follow':
      return handleFollow(ctx, body);
    case 'undo':
      return handleUndo(ctx, body);
    case 'publish-report':
      return handlePublishReport(ctx, body);
    case 'representation':
      return handleRepresentation(ctx, body);
    case 'process-queue':
      return handleProcessQueue(ctx, body);
    case 'process-dispatcher':
      return handleProcessDispatcher(ctx, body);
    case 'state':
      return handleState(ctx);
    default:
      return new Response('not found', { status: 404 });
  }
}

export type HermeticControlContext = {
  readonly label: 'a' | 'b';
  readonly origin: string;
  readonly sql: postgres.Sql;
  readonly actorRepository: ActivityPubRepository;
  readonly followUseCases: ActivityPubFollowUseCases;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly faultController: HermeticFaultController;
  readonly drainQueue: (limit?: number) => Promise<{ processed: number; failed: number }>;
  readonly runDispatcher: (limit?: number) => Promise<{ materialized: number; processed: number }>;
};

async function parseControlBody(request: Request): Promise<Record<string, unknown> | Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return invalidControlRequest();
  }
  if (!isRecord(parsed)) {
    return invalidControlRequest();
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidControlRequest(): Response {
  return jsonResponse(INVALID_CONTROL_REQUEST, 400);
}

function readControlString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

function readOptionalSharedInboxUri(body: Record<string, unknown>): string | null | Response {
  if (!('remoteSharedInboxUri' in body)) {
    return null;
  }
  const value = body.remoteSharedInboxUri;
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return invalidControlRequest();
  }
  return value;
}

function readOptionalPublishedAt(body: Record<string, unknown>, now: () => Date): Date | Response {
  if (!('publishedAt' in body)) {
    return now();
  }
  const value = body.publishedAt;
  if (typeof value !== 'string') {
    return invalidControlRequest();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return invalidControlRequest();
  }
  return parsed;
}

function parseControlLimit(body: Record<string, unknown>): number | Response {
  if (body.limit === undefined) {
    return 50;
  }
  const value = body.limit;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return invalidControlRequest();
  }
  if (value < 1 || value > 100) {
    return invalidControlRequest();
  }
  return value;
}

async function handleSearch(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const acct = readControlString(body, 'acct');
  if (!acct) {
    return invalidControlRequest();
  }
  const resolved = await ctx.followUseCases.resolveRemoteActor(acct);
  return jsonResponse({ ok: true, actor: resolved });
}

async function handleFollow(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const projectSlug = readControlString(body, 'projectSlug');
  const localActorPreferredUsername = readControlString(body, 'localActorPreferredUsername');
  const remoteActorAddress = readControlString(body, 'remoteActorAddress');
  if (!projectSlug || !localActorPreferredUsername || !remoteActorAddress) {
    return invalidControlRequest();
  }
  const actor = await ctx.actorRepository.findRemotelyVisibleActorByUsername(
    localActorPreferredUsername,
  );
  if (!actor) {
    return jsonResponse({ ok: false, error: 'local actor not found' }, 404);
  }
  const uri = buildActivityPubUriContract(ctx.origin);
  const result = await ctx.followUseCases.requestOutboundFollow({
    projectSlug,
    localActorId: actor.id,
    localActorPreferredUsername,
    localActorKeyId: uri.actorKeyId(localActorPreferredUsername),
    remoteActorAddress,
  });
  return jsonResponse({ ok: true, follow: result.follow, enqueued: result.enqueued });
}

async function handleUndo(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const projectSlug = readControlString(body, 'projectSlug');
  const localActorPreferredUsername = readControlString(body, 'localActorPreferredUsername');
  const remoteActorUri = readControlString(body, 'remoteActorUri');
  const remoteInboxUri = readControlString(body, 'remoteInboxUri');
  if (!projectSlug || !localActorPreferredUsername || !remoteActorUri || !remoteInboxUri) {
    return invalidControlRequest();
  }
  const remoteSharedInboxUri = readOptionalSharedInboxUri(body);
  if (remoteSharedInboxUri instanceof Response) {
    return remoteSharedInboxUri;
  }
  const actor = await ctx.actorRepository.findRemotelyVisibleActorByUsername(
    localActorPreferredUsername,
  );
  if (!actor) {
    return jsonResponse({ ok: false, error: 'local actor not found' }, 404);
  }
  const uri = buildActivityPubUriContract(ctx.origin);
  const result = await ctx.followUseCases.requestOutboundUndo({
    projectSlug,
    localActorId: actor.id,
    localActorPreferredUsername,
    localActorKeyId: uri.actorKeyId(localActorPreferredUsername),
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri,
  });
  return jsonResponse({
    ok: true,
    follow: result?.follow ?? null,
    enqueued: Boolean(result?.enqueued),
  });
}

async function handlePublishReport(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const reportId = readControlString(body, 'reportId');
  const publicSummary = readControlString(body, 'publicSummary');
  if (!reportId || !publicSummary) {
    return invalidControlRequest();
  }
  const publishedAt = readOptionalPublishedAt(body, () => ctx.faultController.clock.now());
  if (publishedAt instanceof Response) {
    return publishedAt;
  }
  await ctx.sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin: ctx.origin,
      projectId: ctx.projectId,
      reportId,
      publishedAt,
      publicSummary,
    });
  });
  return jsonResponse({ ok: true });
}

async function handleRepresentation(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const representation = body.representation;
  if (representation !== 'article' && representation !== 'note') {
    return invalidControlRequest();
  }
  const current = await ctx.actorRepository.getInstanceConfig();
  if (current.representationLockedAt) {
    return jsonResponse(
      {
        ok: false,
        error: 'representation is locked after the first outbound activity',
        objectRepresentation: current.objectRepresentation,
      },
      409,
    );
  }
  const config = await ctx.actorRepository.updateInstanceRepresentation(representation);
  return jsonResponse({ ok: true, objectRepresentation: config.objectRepresentation });
}

async function handleProcessQueue(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const limit = parseControlLimit(body);
  if (limit instanceof Response) {
    return limit;
  }
  const result = await ctx.drainQueue(limit);
  return jsonResponse({ ok: true, ...result });
}

async function handleProcessDispatcher(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const limit = parseControlLimit(body);
  if (limit instanceof Response) {
    return limit;
  }
  const result = await ctx.runDispatcher(limit);
  return jsonResponse({ ok: true, ...result });
}

async function handleState(ctx: HermeticControlContext): Promise<Response> {
  const config = await ctx.actorRepository.getInstanceConfig();
  const followRows: readonly unknown[] = await ctx.sql`
    SELECT
      a.preferred_username AS local_actor,
      f.direction,
      f.status,
      f.remote_actor_uri,
      f.remote_inbox_uri,
      f.follow_activity_uri
    FROM public.activitypub_follows f
    JOIN public.activitypub_actors a ON a.id = f.local_actor_id
    ORDER BY f.created_at ASC
  `;
  const queueRows: readonly unknown[] = await ctx.sql`
    SELECT queue_kind, status, attempt_count, last_error_code, available_at, now() AS database_now
    FROM public.activitypub_queue_messages
    ORDER BY created_at ASC
  `;
  const federatedReportRows: readonly unknown[] = await ctx.sql`
    SELECT remote_activity_uri, title, summary_html_sanitized, original_url
    FROM public.federated_reports
    ORDER BY received_at ASC
  `;
  return jsonResponse({
    ok: true,
    label: ctx.label,
    origin: ctx.origin,
    objectRepresentation: config.objectRepresentation,
    follows: followRows.map(parseHermeticFollowStateRow),
    queue: queueRows.map(parseHermeticQueueStateRow),
    federatedReports: federatedReportRows.map(parseHermeticFederatedReportStateRow),
  });
}

function parseHermeticFollowStateRow(row: unknown) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('invalid follow state row');
  }
  const localActor = Reflect.get(row, 'local_actor');
  const direction = Reflect.get(row, 'direction');
  const status = Reflect.get(row, 'status');
  const remoteActorUri = Reflect.get(row, 'remote_actor_uri');
  const remoteInboxUri = Reflect.get(row, 'remote_inbox_uri');
  const followActivityUri = Reflect.get(row, 'follow_activity_uri');
  if (
    typeof localActor !== 'string' ||
    typeof direction !== 'string' ||
    (direction !== 'inbound' && direction !== 'outbound') ||
    typeof status !== 'string' ||
    !FOLLOW_STATUSES.has(status) ||
    typeof remoteActorUri !== 'string' ||
    typeof remoteInboxUri !== 'string' ||
    typeof followActivityUri !== 'string'
  ) {
    throw new Error('invalid follow state row');
  }
  return {
    local_actor: localActor,
    direction,
    status,
    remote_actor_uri: remoteActorUri,
    remote_inbox_uri: remoteInboxUri,
    follow_activity_uri: followActivityUri,
  };
}

function parseHermeticQueueStateRow(row: unknown) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('invalid queue state row');
  }
  const queueKind = Reflect.get(row, 'queue_kind');
  const status = Reflect.get(row, 'status');
  const attemptCount = Reflect.get(row, 'attempt_count');
  const lastErrorCode = Reflect.get(row, 'last_error_code');
  const availableAt = Reflect.get(row, 'available_at');
  const databaseNow = Reflect.get(row, 'database_now');
  if (
    (queueKind !== 'inbox' && queueKind !== 'outbox') ||
    typeof status !== 'string' ||
    !QUEUE_STATUSES.has(status) ||
    typeof attemptCount !== 'number' ||
    (lastErrorCode !== null && typeof lastErrorCode !== 'string') ||
    !(availableAt instanceof Date) ||
    !(databaseNow instanceof Date)
  ) {
    throw new Error('invalid queue state row');
  }
  return {
    queue_kind: queueKind,
    status,
    attempt_count: attemptCount,
    last_error_code: lastErrorCode,
    available_at: availableAt,
    database_now: databaseNow,
  };
}

function parseHermeticFederatedReportStateRow(row: unknown) {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('invalid federated report state row');
  }
  const remoteActivityUri = Reflect.get(row, 'remote_activity_uri');
  const title = Reflect.get(row, 'title');
  const summaryHtmlSanitized = Reflect.get(row, 'summary_html_sanitized');
  const originalUrl = Reflect.get(row, 'original_url');
  if (
    typeof remoteActivityUri !== 'string' ||
    typeof title !== 'string' ||
    typeof summaryHtmlSanitized !== 'string' ||
    typeof originalUrl !== 'string'
  ) {
    throw new Error('invalid federated report state row');
  }
  return {
    remote_activity_uri: remoteActivityUri,
    title,
    summary_html_sanitized: summaryHtmlSanitized,
    original_url: originalUrl,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
