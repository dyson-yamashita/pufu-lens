import type postgres from 'postgres';
import type { ActivityPubRepository } from '../actor-repository.ts';
import type { ActivityPubFollowUseCases } from '../follow-use-cases.ts';
import { enqueueReportPublicationOutbox } from '../report-publication-outbox.ts';
import type { ObjectRepresentation } from '../schema.ts';
import { assertActivityPubHermeticE2eRuntime } from '../test-runtime-guard.ts';
import { buildActivityPubUriContract } from '../uri-contract.ts';
import type { HermeticFaultController } from './fault-controller.ts';

const CONTROL_PREFIX = '/__hermetic__/';

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
  const body = (await request.json()) as Record<string, unknown>;

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

async function handleSearch(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const acct = readString(body, 'acct');
  const resolved = await ctx.followUseCases.resolveRemoteActor(acct);
  return jsonResponse({ ok: true, actor: resolved });
}

async function handleFollow(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const projectSlug = readString(body, 'projectSlug');
  const localActorPreferredUsername = readString(body, 'localActorPreferredUsername');
  const remoteActorAddress = readString(body, 'remoteActorAddress');
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
  const projectSlug = readString(body, 'projectSlug');
  const localActorPreferredUsername = readString(body, 'localActorPreferredUsername');
  const remoteActorUri = readString(body, 'remoteActorUri');
  const remoteInboxUri = readString(body, 'remoteInboxUri');
  const remoteSharedInboxUri =
    typeof body.remoteSharedInboxUri === 'string' ? body.remoteSharedInboxUri : null;
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
  const reportId = readString(body, 'reportId');
  const publicSummary = readString(body, 'publicSummary');
  const publishedAt =
    typeof body.publishedAt === 'string' ? new Date(body.publishedAt) : new Date();
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
    return jsonResponse({ ok: false, error: 'invalid representation' }, 400);
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
  const limit = typeof body.limit === 'number' ? body.limit : 50;
  const result = await ctx.drainQueue(limit);
  return jsonResponse({ ok: true, ...result });
}

async function handleProcessDispatcher(
  ctx: HermeticControlContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const limit = typeof body.limit === 'number' ? body.limit : 50;
  const result = await ctx.runDispatcher(limit);
  return jsonResponse({ ok: true, ...result });
}

async function handleState(ctx: HermeticControlContext): Promise<Response> {
  const config = await ctx.actorRepository.getInstanceConfig();
  const follows = await ctx.sql<
    {
      local_actor: string;
      direction: string;
      status: string;
      remote_actor_uri: string;
      remote_inbox_uri: string;
      follow_activity_uri: string;
    }[]
  >`
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
  const queue = await ctx.sql<
    {
      queue_kind: string;
      status: string;
      attempt_count: number;
      last_error_code: string | null;
      available_at: Date;
      database_now: Date;
    }[]
  >`
    SELECT queue_kind, status, attempt_count, last_error_code, available_at, now() AS database_now
    FROM public.activitypub_queue_messages
    ORDER BY created_at ASC
  `;
  const federatedReports = await ctx.sql<{ remote_activity_uri: string; title: string }[]>`
    SELECT remote_activity_uri, title, summary_html_sanitized, original_url
    FROM public.federated_reports
    ORDER BY received_at ASC
  `;
  return jsonResponse({
    ok: true,
    label: ctx.label,
    origin: ctx.origin,
    objectRepresentation: config.objectRepresentation,
    follows,
    queue,
    federatedReports,
  });
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`control route missing ${key}`);
  }
  return value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
