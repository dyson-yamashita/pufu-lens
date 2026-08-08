'use server';

import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import {
  ActivityPubSubscriptionError,
  mapActivityPubSubscriptionErrorMessage,
} from './activitypub-subscription-errors.ts';
import {
  followRemoteActorForProjectAdmin,
  unfollowRemoteActorForProjectAdmin,
} from './activitypub-subscription-service.ts';
import {
  validateSubscriptionProjectSlugOrThrow,
  validateSubscriptionRemoteActorAddressOrThrow,
  validateSubscriptionRemoteActorUriOrThrow,
} from './activitypub-subscription-validation.ts';

const GENERIC_ACTION_ERROR = 'Unable to update ActivityPub subscription. Try again later.';

/**
 * Requests an outbound Follow for the project ActivityPub actor.
 * Project admins only; rejects cross-project scope and invalid actor addresses.
 */
export async function followRemoteActor(formData: FormData): Promise<void> {
  try {
    const projectSlug = readRequiredFormValue(formData, 'projectSlug');
    const remoteActorAddress = readRequiredFormValue(formData, 'remoteActorAddress');
    validateSubscriptionProjectSlugOrThrow(projectSlug);
    validateSubscriptionRemoteActorAddressOrThrow(remoteActorAddress);

    await withSqlBoundary(async (sql) => {
      const userId = await requireAdminUserIdSafe();
      await followRemoteActorForProjectAdmin(sql, {
        userId,
        projectSlug,
        remoteActorAddress: remoteActorAddress.trim(),
      });
    });

    revalidateProjectSubscriptionPaths(projectSlug);
  } catch (error) {
    throw toSafeActionError(error);
  }
}

/**
 * Requests an outbound Undo(Follow) for an existing outbound subscription.
 * Project admins only; uses stored remote actor URI without exposing inbox metadata in errors.
 */
export async function unfollowRemoteActor(formData: FormData): Promise<void> {
  try {
    const projectSlug = readRequiredFormValue(formData, 'projectSlug');
    const remoteActorUri = readRequiredFormValue(formData, 'remoteActorUri');
    validateSubscriptionProjectSlugOrThrow(projectSlug);
    validateSubscriptionRemoteActorUriOrThrow(remoteActorUri);

    await withSqlBoundary(async (sql) => {
      const userId = await requireAdminUserIdSafe();
      await unfollowRemoteActorForProjectAdmin(sql, {
        userId,
        projectSlug,
        remoteActorUri,
      });
    });

    revalidateProjectSubscriptionPaths(projectSlug);
  } catch (error) {
    throw toSafeActionError(error);
  }
}

function readRequiredFormValue(formData: FormData, key: string): string {
  const value = formData.get(key)?.toString()?.trim();
  if (!value) {
    throw new ActivityPubSubscriptionError('invalid_input', `${key} is required`);
  }
  return value;
}

function revalidateProjectSubscriptionPaths(projectSlug: string): void {
  revalidatePath(`/projects/${projectSlug}/settings`);
  revalidatePath(`/projects/${projectSlug}/admin/settings`);
}

async function withSqlBoundary(callback: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const { withSql } = await import('./admin-actions-shared.ts');
  await withSql(callback);
}

async function requireAdminUserIdSafe(): Promise<string> {
  const { requireAdminUserId } = await import('./admin-actions-shared.ts');
  return requireAdminUserId();
}

function toSafeActionError(error: unknown): ActivityPubSubscriptionError {
  if (error instanceof ActivityPubSubscriptionError) {
    return error;
  }
  const message = mapActivityPubSubscriptionErrorMessage(error);
  if (message === GENERIC_ACTION_ERROR) {
    return new ActivityPubSubscriptionError('remote_resolution_failed', message);
  }
  return new ActivityPubSubscriptionError('remote_resolution_failed', message);
}
