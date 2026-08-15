import {
  ActivityPubActorProfileError,
  createActivityPubUseCases,
  parseActorKeyEncryptionKey,
} from '@pufu-lens/activitypub';
import type postgres from 'postgres';
import { lookupGlobalAdminUserId, lookupProjectAdminAccess } from './authz.ts';

/** Stable admin boundary error with machine-readable code and HTTP status. */
export class ActivityPubProfileAdminError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Maps profile validation and authorization failures to sanitized admin errors. */
export function mapActivityPubProfileAdminError(error: unknown): ActivityPubProfileAdminError {
  if (error instanceof ActivityPubProfileAdminError) {
    return error;
  }
  if (error instanceof ActivityPubActorProfileError) {
    return new ActivityPubProfileAdminError('invalid_profile', error.message, 400);
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return new ActivityPubProfileAdminError(
      'actor_not_found',
      'ActivityPub actor was not found.',
      404,
    );
  }
  if (error instanceof Error && /access|admin|authentication/i.test(error.message)) {
    return new ActivityPubProfileAdminError('forbidden', 'Admin access is required.', 403);
  }
  return new ActivityPubProfileAdminError(
    'activitypub_internal_error',
    'An unexpected error occurred',
    500,
  );
}

function resolveActivityPubUseCases(sql: postgres.Sql | postgres.TransactionSql) {
  return createActivityPubUseCases({
    sql: sql as postgres.Sql,
    encryptionKey: parseActorKeyEncryptionKey(process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY),
  });
}

/**
 * Updates aggregate `@all` profile fields for a global app admin.
 */
export async function updateAggregateActivityPubProfile(input: {
  readonly sql: postgres.Sql | postgres.TransactionSql;
  readonly userId: string;
  readonly displayName: string;
  readonly iconUrl?: string | null;
  readonly additionalPrompt?: string | null;
}): Promise<void> {
  const adminUserId = await lookupGlobalAdminUserId(input.sql, { userId: input.userId });
  if (!adminUserId) {
    throw new ActivityPubProfileAdminError('forbidden', 'Global admin access is required.', 403);
  }
  const useCases = resolveActivityPubUseCases(input.sql);
  await useCases.updateAggregateActorProfile({
    displayName: input.displayName,
    iconUrl: input.iconUrl,
    additionalPrompt: input.additionalPrompt,
  });
}

/**
 * Enables or disables the aggregate `@all` actor for a global app admin.
 */
export async function setAggregateActivityPubEnabled(input: {
  readonly sql: postgres.Sql | postgres.TransactionSql;
  readonly userId: string;
  readonly enabled: boolean;
}): Promise<void> {
  const adminUserId = await lookupGlobalAdminUserId(input.sql, { userId: input.userId });
  if (!adminUserId) {
    throw new ActivityPubProfileAdminError('forbidden', 'Global admin access is required.', 403);
  }
  const useCases = resolveActivityPubUseCases(input.sql);
  await useCases.setAggregateActorEnabled(input.enabled);
}

/**
 * Updates a project actor profile for a project admin or global app admin.
 */
export async function updateProjectActivityPubProfile(input: {
  readonly sql: postgres.Sql | postgres.TransactionSql;
  readonly userId: string;
  readonly projectSlug: string;
  readonly displayName: string;
  readonly iconUrl?: string | null;
  readonly additionalPrompt?: string | null;
}): Promise<void> {
  const access = await lookupProjectAdminAccess(input.sql, {
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!access) {
    throw new ActivityPubProfileAdminError('forbidden', 'Project admin access is required.', 403);
  }
  const useCases = resolveActivityPubUseCases(input.sql);
  await useCases.updateProjectActorProfile({
    projectId: access.id,
    projectSlug: access.slug,
    displayName: input.displayName,
    iconUrl: input.iconUrl,
    additionalPrompt: input.additionalPrompt,
  });
}
