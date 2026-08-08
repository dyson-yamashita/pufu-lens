import {
  ActivityPubPreferredUsernameConflictError,
  ActivityPubProjectNotPublicError,
  createActivityPubUseCases,
  parseActorKeyEncryptionKey,
} from '@pufu-lens/activitypub';
import { validateProjectSlug } from '@pufu-lens/project-tenancy';
import type postgres from 'postgres';
import { lookupProjectAdminAccess } from './authz.ts';

/** Federation enable/disable request accepted by the project federation PATCH route. */
export type ProjectFederationRequest = {
  /** When true, enables federation; when false, disables the project actor. */
  readonly enabled: boolean;
  /** Optional username override allowed only while enabling federation. */
  readonly preferredUsername?: string;
};

/** Federation state returned after a successful project federation mutation. */
export type ProjectFederationResponse = {
  /** Whether the project ActivityPub actor is currently enabled. */
  readonly enabled: boolean;
  /** Federated username bound to the project actor. */
  readonly preferredUsername: string;
  /** Persisted ActivityPub actor id. */
  readonly actorId: string;
};

const ALLOWED_BODY_KEYS = new Set(['enabled', 'preferredUsername']);

/**
 * Stable admin boundary error with a machine-readable `code` and HTTP response `status`.
 * Callers must return `status` as the response status and expose `code` in JSON error payloads.
 */
export class ActivityPubAdminError extends Error {
  /** Machine-readable error code for API clients. */
  readonly code: string;
  /** HTTP response status for the mapped admin error. */
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Maps repository and unexpected failures to sanitized ActivityPub admin errors.
 *
 * Typed mappings:
 * - `ActivityPubProjectNotPublicError` -> `project_not_public`, 400
 * - `ActivityPubPreferredUsernameConflictError` -> `preferred_username_conflict`, 409
 * - existing `ActivityPubAdminError` values are returned unchanged
 * - all other errors -> `activitypub_internal_error`, 500 with a fixed generic message
 *
 * @returns A sanitized `ActivityPubAdminError` safe to expose through the admin API.
 */
export function mapActivityPubAdminError(error: unknown): ActivityPubAdminError {
  if (error instanceof ActivityPubAdminError) {
    return error;
  }
  if (error instanceof ActivityPubProjectNotPublicError) {
    return new ActivityPubAdminError(
      'project_not_public',
      'Project must be public to enable ActivityPub federation',
      400,
    );
  }
  if (error instanceof ActivityPubPreferredUsernameConflictError) {
    return new ActivityPubAdminError(
      'preferred_username_conflict',
      'Preferred username is already assigned to another ActivityPub actor',
      409,
    );
  }
  return new ActivityPubAdminError(
    'activitypub_internal_error',
    'An unexpected error occurred',
    500,
  );
}

/**
 * Parses and validates the project federation PATCH request body.
 *
 * @returns Canonical `{ enabled, preferredUsername? }` request shape.
 * @throws {ActivityPubAdminError} When the body is not an object, contains unknown fields,
 * `enabled` is not boolean, or `preferredUsername` violates enable-only / slug / reserved-name rules.
 */
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

/**
 * Updates project federation settings after project-admin or app-admin authorization.
 *
 * Requires exact project id+slug scope, enables or disables the project ActivityPub actor,
 * and maps repository failures to stable admin errors.
 *
 * @returns Current federation state for the project actor.
 * @throws {ActivityPubAdminError}
 * - `invalid_slug` (400) for malformed route slugs
 * - `forbidden` (403) when the caller lacks project-admin access or scope mismatches
 * - `project_not_public` (400) when enabling on a private project
 * - `preferred_username_conflict` (409) when the requested username is already taken
 * - `activitypub_internal_error` (500) for unexpected auth lookup, config, or repository failures
 */
export async function patchProjectFederation(input: {
  sql: postgres.Sql;
  userId: string;
  projectSlug: string;
  body: ProjectFederationRequest;
  encryptionKey?: Buffer;
  useCases?: ReturnType<typeof createActivityPubUseCases>;
}): Promise<ProjectFederationResponse> {
  let projectSlug: string;
  try {
    projectSlug = validateProjectSlug(input.projectSlug);
  } catch {
    throw new ActivityPubAdminError('invalid_slug', 'Invalid project slug', 400);
  }

  try {
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
  } catch (error) {
    throw mapActivityPubAdminError(error);
  }
}
