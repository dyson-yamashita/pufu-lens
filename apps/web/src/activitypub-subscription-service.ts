import {
  type ActivityPubFollowUseCases,
  buildActivityPubUriContract,
  createActivityPubFollowUseCases,
  parseActorKeyEncryptionKey,
  parseBlockedDomainsFromEnv,
} from '@pufu-lens/activitypub';
import type postgres from 'postgres';
import { resolveActivityPubCanonicalOrigin } from './activitypub-runtime.ts';
import {
  ActivityPubSubscriptionError,
  mapActivityPubSubscriptionErrorMessage,
} from './activitypub-subscription-errors.ts';
import {
  parseOutboundFollowSubscriptionRow,
  parseSubscriptionProjectActorRow,
} from './activitypub-subscription-rows.ts';
import { lookupProjectAdminAccess } from './authz.ts';

export { ActivityPubSubscriptionError } from './activitypub-subscription-errors.ts';

type SubscriptionServiceDeps = {
  followUseCases?: ActivityPubFollowUseCases;
  encryptionKey?: Buffer;
  canonicalOrigin?: string;
};

/**
 * Follows a remote actor on behalf of a project admin.
 * Enforces project-admin authorization and project-scoped actor lookup.
 */
export async function followRemoteActorForProjectAdmin(
  sql: postgres.Sql,
  input: {
    userId: string;
    projectSlug: string;
    remoteActorAddress: string;
  } & SubscriptionServiceDeps,
): Promise<void> {
  try {
    const access = await assertProjectAdminAccess(sql, {
      userId: input.userId,
      projectSlug: input.projectSlug,
    });
    const actor = await loadProjectActorOrThrow(sql, access.id);
    const followUseCases =
      input.followUseCases ??
      createDefaultFollowUseCases(sql, {
        encryptionKey: input.encryptionKey,
        canonicalOrigin: input.canonicalOrigin,
      });
    const canonicalOrigin = input.canonicalOrigin ?? resolveActivityPubCanonicalOrigin();
    const uri = buildActivityPubUriContract(canonicalOrigin);

    await followUseCases.requestOutboundFollow({
      projectSlug: access.slug,
      localActorId: actor.id,
      localActorPreferredUsername: actor.preferred_username,
      localActorKeyId: uri.actorKeyId(actor.preferred_username),
      remoteActorAddress: input.remoteActorAddress,
    });
  } catch (error) {
    throw toActivityPubSubscriptionError(error);
  }
}

/**
 * Unfollows a remote actor on behalf of a project admin.
 * Enforces project-admin authorization and project-scoped follow lookup.
 */
export async function unfollowRemoteActorForProjectAdmin(
  sql: postgres.Sql,
  input: {
    userId: string;
    projectSlug: string;
    remoteActorUri: string;
  } & SubscriptionServiceDeps,
): Promise<void> {
  try {
    const access = await assertProjectAdminAccess(sql, {
      userId: input.userId,
      projectSlug: input.projectSlug,
    });
    const actor = await loadProjectActorOrThrow(sql, access.id);
    const followRows = (await sql`
      SELECT remote_actor_uri, remote_inbox_uri, remote_shared_inbox_uri
      FROM public.activitypub_follows
      WHERE local_actor_id = ${actor.id}::uuid
        AND direction = 'outbound'
        AND remote_actor_uri = ${input.remoteActorUri}
      LIMIT 1
    `) as readonly unknown[];
    const follow = followRows[0] ? parseOutboundFollowSubscriptionRow(followRows[0]) : undefined;
    if (!follow) {
      throw new ActivityPubSubscriptionError(
        'subscription_not_found',
        'Subscription was not found',
      );
    }

    const followUseCases =
      input.followUseCases ??
      createDefaultFollowUseCases(sql, {
        encryptionKey: input.encryptionKey,
        canonicalOrigin: input.canonicalOrigin,
      });
    const canonicalOrigin = input.canonicalOrigin ?? resolveActivityPubCanonicalOrigin();
    const uri = buildActivityPubUriContract(canonicalOrigin);

    const result = await followUseCases.requestOutboundUndo({
      projectSlug: access.slug,
      localActorId: actor.id,
      localActorPreferredUsername: actor.preferred_username,
      localActorKeyId: uri.actorKeyId(actor.preferred_username),
      remoteActorUri: follow.remote_actor_uri,
      remoteInboxUri: follow.remote_inbox_uri,
      remoteSharedInboxUri: follow.remote_shared_inbox_uri,
    });
    if (!result) {
      throw new ActivityPubSubscriptionError(
        'subscription_not_found',
        'Subscription was not found',
      );
    }
  } catch (error) {
    throw toActivityPubSubscriptionError(error);
  }
}

async function assertProjectAdminAccess(
  sql: postgres.Sql,
  input: { userId: string; projectSlug: string },
): Promise<Awaited<ReturnType<typeof lookupProjectAdminAccess>> & { id: string; slug: string }> {
  try {
    const access = await lookupProjectAdminAccess(sql, {
      projectSlug: input.projectSlug,
      userId: input.userId,
    });
    if (!access || access.slug !== input.projectSlug) {
      throw new ActivityPubSubscriptionError('forbidden', 'Project admin access is required');
    }
    return access;
  } catch (error) {
    throw toActivityPubSubscriptionError(error);
  }
}

function createDefaultFollowUseCases(
  sql: postgres.Sql,
  input: { encryptionKey?: Buffer; canonicalOrigin?: string },
): ActivityPubFollowUseCases {
  const canonicalOrigin = input.canonicalOrigin ?? resolveActivityPubCanonicalOrigin();
  const encryptionKey =
    input.encryptionKey ??
    parseActorKeyEncryptionKey(process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY);
  return createActivityPubFollowUseCases({
    canonicalOrigin,
    sql,
    encryptionKey,
    isDomainBlocked: parseBlockedDomainsFromEnv(process.env.ACTIVITYPUB_BLOCKED_DOMAINS),
  });
}

async function loadProjectActorOrThrow(
  sql: postgres.Sql,
  projectId: string,
): Promise<ReturnType<typeof parseSubscriptionProjectActorRow>> {
  const actorRows = (await sql`
    SELECT id::text AS id, enabled, preferred_username
    FROM public.activitypub_actors
    WHERE project_id = ${projectId}::uuid
      AND kind = 'project'
    LIMIT 1
  `) as readonly unknown[];
  const actor = actorRows[0] ? parseSubscriptionProjectActorRow(actorRows[0]) : undefined;
  if (!actor?.enabled) {
    throw new ActivityPubSubscriptionError(
      'federation_disabled',
      'ActivityPub federation is not enabled for this project',
    );
  }
  return actor;
}

function toActivityPubSubscriptionError(error: unknown): ActivityPubSubscriptionError {
  if (error instanceof ActivityPubSubscriptionError) {
    return error;
  }
  const message = mapActivityPubSubscriptionErrorMessage(error);
  return new ActivityPubSubscriptionError('remote_resolution_failed', message);
}
