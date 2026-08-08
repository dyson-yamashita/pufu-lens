import { createPostgresActivityPubFollowRepository } from '@pufu-lens/activitypub';
import type postgres from 'postgres';
import type { ProjectActivityPubSubscriptionSettingsView } from './activitypub-subscription-presentation.ts';
import { parseSubscriptionSettingsActorRow } from './activitypub-subscription-rows.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/**
 * Reads project-scoped ActivityPub subscription settings for members and admins.
 * Never exposes inbox URLs, private keys, or raw federation payloads.
 */
export async function readProjectActivityPubSubscriptionSettings(
  sql: SqlExecutor,
  input: { projectSlug: string },
): Promise<ProjectActivityPubSubscriptionSettingsView> {
  const actorRows = (await sql`
    SELECT
      a.id::text AS id,
      a.enabled,
      a.preferred_username,
      p.id::text AS project_id
    FROM public.projects p
    JOIN public.activitypub_actors a
      ON a.project_id = p.id
     AND a.kind = 'project'
    WHERE p.slug = ${input.projectSlug}
    LIMIT 1
  `) as readonly unknown[];

  const actor = actorRows[0] ? parseSubscriptionSettingsActorRow(actorRows[0]) : undefined;
  if (!actor) {
    return {
      federationEnabled: false,
      preferredUsername: null,
      subscriptions: [],
    };
  }

  const followRepository = createPostgresActivityPubFollowRepository({
    sql: sql as postgres.Sql,
  });
  const follows = await followRepository.listProjectOutboundFollows({
    projectId: actor.project_id,
  });

  return {
    federationEnabled: actor.enabled,
    preferredUsername: actor.preferred_username,
    subscriptions: follows.map((follow) => ({
      remoteActorAddress: follow.remoteActorUri,
      status: follow.status,
    })),
  };
}
