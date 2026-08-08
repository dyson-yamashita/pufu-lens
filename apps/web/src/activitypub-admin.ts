import { createActivityPubUseCases, parseActorKeyEncryptionKey } from '@pufu-lens/activitypub';
import { validateProjectSlug } from '@pufu-lens/project-tenancy';
import type postgres from 'postgres';
import { lookupProjectAdminAccess } from './authz.ts';

export type ProjectFederationRequest = {
  readonly enabled: boolean;
  readonly preferredUsername?: string;
};

export type ProjectFederationResponse = {
  readonly enabled: boolean;
  readonly preferredUsername: string;
  readonly actorId: string;
};

const ALLOWED_BODY_KEYS = new Set(['enabled', 'preferredUsername']);

export class ActivityPubAdminError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Parses and validates the project federation PATCH request body. */
export function parseProjectFederationRequest(body: unknown): ProjectFederationRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ActivityPubAdminError('invalid_body', 'Request body must be a JSON object', 400);
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_BODY_KEYS.has(key)) {
      throw new ActivityPubAdminError('invalid_body', `Unknown request field: ${key}`, 400);
    }
  }
  if (typeof record.enabled !== 'boolean') {
    throw new ActivityPubAdminError('invalid_body', 'enabled must be a boolean', 400);
  }
  if (record.preferredUsername !== undefined) {
    if (!record.enabled) {
      throw new ActivityPubAdminError(
        'invalid_body',
        'preferredUsername is only allowed when enabling federation',
        400,
      );
    }
    if (typeof record.preferredUsername !== 'string') {
      throw new ActivityPubAdminError('invalid_body', 'preferredUsername must be a string', 400);
    }
    if (record.preferredUsername.trim().length === 0) {
      throw new ActivityPubAdminError('invalid_body', 'preferredUsername must not be empty', 400);
    }
    try {
      validateProjectSlug(record.preferredUsername);
    } catch {
      throw new ActivityPubAdminError('invalid_body', 'preferredUsername is invalid', 400);
    }
    if (record.preferredUsername === 'all') {
      throw new ActivityPubAdminError('invalid_body', 'preferredUsername cannot be all', 400);
    }
  }
  return {
    enabled: record.enabled,
    preferredUsername: record.preferredUsername,
  };
}

/** Updates project federation settings after project-admin authorization. */
export async function patchProjectFederation(input: {
  sql: postgres.Sql;
  userId: string;
  projectSlug: string;
  body: ProjectFederationRequest;
  encryptionKey?: Buffer;
  useCases?: ReturnType<typeof createActivityPubUseCases>;
}): Promise<ProjectFederationResponse> {
  const projectSlug = validateProjectSlug(input.projectSlug);
  const access = await lookupProjectAdminAccess(input.sql, {
    projectSlug,
    userId: input.userId,
  });
  if (!access) {
    throw new ActivityPubAdminError('forbidden', 'Project admin access is required', 403);
  }
  if (access.slug !== projectSlug) {
    throw new ActivityPubAdminError('forbidden', 'Project scope mismatch', 403);
  }

  const encryptionKey =
    input.encryptionKey ??
    parseActorKeyEncryptionKey(process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY);
  const useCases =
    input.useCases ??
    createActivityPubUseCases({
      sql: input.sql,
      encryptionKey,
    });

  const actor = input.body.enabled
    ? await useCases.enableProjectActor({
        projectId: access.id,
        projectSlug: access.slug,
        preferredUsername: input.body.preferredUsername,
      })
    : await useCases.disableProjectActor({
        projectId: access.id,
        projectSlug: access.slug,
      });

  return {
    enabled: actor.enabled,
    preferredUsername: actor.preferredUsername,
    actorId: actor.id,
  };
}
