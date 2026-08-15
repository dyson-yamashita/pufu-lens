import type postgres from 'postgres';
import type { ServerActivityPubProfileSettingsView } from './activitypub-profile-presentation.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

type AggregateProfileRow = {
  readonly id: string;
  readonly preferred_username: string;
  readonly display_name: string;
  readonly icon_url: string | null;
  readonly additional_prompt: string | null;
  readonly enabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses aggregate actor profile columns from a SQL row at the runtime boundary. */
export function parseAggregateActivityPubProfileRow(row: unknown): AggregateProfileRow {
  if (!isRecord(row)) {
    throw new Error('Invalid aggregate ActivityPub profile row.');
  }
  const id = row.id;
  const preferredUsername = row.preferred_username;
  const displayName = row.display_name;
  const iconUrl = row.icon_url;
  const additionalPrompt = row.additional_prompt;
  const enabled = row.enabled;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid aggregate ActivityPub profile row id.');
  }
  if (typeof preferredUsername !== 'string' || preferredUsername.length === 0) {
    throw new Error('Invalid aggregate ActivityPub profile row preferred_username.');
  }
  if (typeof displayName !== 'string') {
    throw new Error('Invalid aggregate ActivityPub profile row display_name.');
  }
  if (iconUrl !== null && typeof iconUrl !== 'string') {
    throw new Error('Invalid aggregate ActivityPub profile row icon_url.');
  }
  if (additionalPrompt !== null && typeof additionalPrompt !== 'string') {
    throw new Error('Invalid aggregate ActivityPub profile row additional_prompt.');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Invalid aggregate ActivityPub profile row enabled.');
  }
  return {
    id,
    preferred_username: preferredUsername,
    display_name: displayName,
    icon_url: iconUrl,
    additional_prompt: additionalPrompt,
    enabled,
  };
}

type ProjectProfileRow = AggregateProfileRow & {
  readonly project_id: string;
};

/** Parses project actor profile columns from a SQL row at the runtime boundary. */
export function parseProjectActivityPubProfileRow(row: unknown): ProjectProfileRow {
  const base = parseAggregateActivityPubProfileRow(row);
  if (!isRecord(row)) {
    throw new Error('Invalid project ActivityPub profile row.');
  }
  const projectId = row.project_id;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('Invalid project ActivityPub profile row project_id.');
  }
  return { ...base, project_id: projectId };
}

/**
 * Reads server-wide aggregate `@all` ActivityPub profile settings.
 * When `canManage` is false, `additionalPrompt` is masked and profile editing flags are disabled.
 */
export async function readServerActivityPubProfileSettings(
  sql: SqlExecutor,
  input: { readonly canManage: boolean },
): Promise<ServerActivityPubProfileSettingsView> {
  const rows = (await sql`
    SELECT
      a.id::text AS id,
      a.preferred_username,
      a.display_name,
      a.icon_url,
      a.additional_prompt,
      a.enabled
    FROM public.activitypub_actors a
    WHERE a.kind = 'aggregate'
    LIMIT 1
  `) as readonly unknown[];
  const actor = rows[0] ? parseAggregateActivityPubProfileRow(rows[0]) : undefined;
  if (!actor) {
    return {
      actorId: null,
      preferredUsername: 'all',
      displayName: 'All Projects',
      iconUrl: null,
      additionalPrompt: null,
      federationEnabled: false,
      canEditProfile: input.canManage,
      canEditPrompt: input.canManage,
      profileSavePendingHint: 'Enable the aggregate actor before saving profile settings.',
      deploymentMasterSwitchNote:
        'ACTIVITYPUB_ENABLED remains the deployment master switch. This control changes the aggregate actor only.',
    };
  }
  return {
    actorId: actor.id,
    preferredUsername: actor.preferred_username,
    displayName: actor.display_name,
    iconUrl: actor.icon_url,
    additionalPrompt: input.canManage ? actor.additional_prompt : null,
    federationEnabled: actor.enabled,
    canEditProfile: input.canManage,
    canEditPrompt: input.canManage,
    profileSavePendingHint: null,
    deploymentMasterSwitchNote:
      'ACTIVITYPUB_ENABLED remains the deployment master switch. This control changes the aggregate actor only.',
  };
}

/**
 * Reads project ActivityPub profile settings for admins or read-only members.
 */
export async function readProjectActivityPubProfileSettings(
  sql: SqlExecutor,
  input: { readonly projectSlug: string; readonly canManage: boolean },
): Promise<import('./activitypub-profile-presentation.ts').ProjectActivityPubProfileSettingsView> {
  const rows = (await sql`
    SELECT
      a.id::text AS id,
      p.id::text AS project_id,
      a.preferred_username,
      a.display_name,
      a.icon_url,
      a.additional_prompt,
      a.enabled
    FROM public.projects p
    LEFT JOIN public.activitypub_actors a
      ON a.project_id = p.id
     AND a.kind = 'project'
    WHERE p.slug = ${input.projectSlug}
    LIMIT 1
  `) as readonly unknown[];
  const row = rows[0];
  if (!row || !isRecord(row) || row.id === null || row.id === undefined) {
    return {
      actorId: null,
      preferredUsername: input.projectSlug,
      displayName: '',
      iconUrl: null,
      additionalPrompt: null,
      federationEnabled: false,
      canEditProfile: input.canManage,
      canEditPrompt: input.canManage,
      profileSavePendingHint: input.canManage
        ? 'Enable ActivityPub for this project before saving profile settings.'
        : null,
    };
  }
  const actor = parseProjectActivityPubProfileRow(row);
  return {
    actorId: actor.id,
    preferredUsername: actor.preferred_username,
    displayName: actor.display_name,
    iconUrl: actor.icon_url,
    additionalPrompt: input.canManage ? actor.additional_prompt : null,
    federationEnabled: actor.enabled,
    canEditProfile: input.canManage,
    canEditPrompt: input.canManage,
    profileSavePendingHint: null,
  };
}
