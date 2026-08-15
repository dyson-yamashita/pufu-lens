'use server';

import { revalidatePath } from 'next/cache';
import { parseFederationEnabledFormValue } from './activitypub-federation-form.ts';
import {
  ActivityPubProfileAdminError,
  mapActivityPubProfileAdminError,
  setAggregateActivityPubEnabled,
  updateAggregateActivityPubProfile,
  updateProjectActivityPubProfile,
} from './activitypub-profile-admin.ts';
import { requireFormValue } from './admin-actions-shared.ts';

const GENERIC_ACTION_ERROR = 'Unable to update ActivityPub profile settings. Try again later.';

/**
 * Saves aggregate `@all` ActivityPub profile fields for a global app admin.
 */
export async function saveAggregateActivityPubProfile(formData: FormData): Promise<void> {
  try {
    const displayName = readRequiredFormValue(formData, 'displayName');
    const iconUrl = readOptionalFormValue(formData, 'iconUrl');
    const additionalPrompt = readOptionalFormValue(formData, 'additionalPrompt');
    const { withSql, requireAdminUserId } = await import('./admin-actions-shared.ts');
    await withSql(async (sql) => {
      const userId = await requireAdminUserId();
      await updateAggregateActivityPubProfile({
        sql,
        userId,
        displayName,
        iconUrl,
        additionalPrompt,
      });
    });
    revalidatePath('/settings');
  } catch (error) {
    throw toSafeActionError(error);
  }
}

/**
 * Enables or disables the aggregate `@all` ActivityPub actor for a global app admin.
 */
export async function setAggregateActivityPubFederationEnabled(formData: FormData): Promise<void> {
  try {
    const enabled = parseFederationEnabledFormValue(readRequiredFormValue(formData, 'enabled'));
    const { withSql, requireAdminUserId } = await import('./admin-actions-shared.ts');
    await withSql(async (sql) => {
      const userId = await requireAdminUserId();
      await setAggregateActivityPubEnabled({ sql, userId, enabled });
    });
    revalidatePath('/settings');
  } catch (error) {
    throw toSafeActionError(error);
  }
}

/**
 * Saves project ActivityPub profile fields for a project admin.
 */
export async function saveProjectActivityPubProfile(formData: FormData): Promise<void> {
  try {
    const projectSlug = readRequiredFormValue(formData, 'projectSlug');
    const displayName = readRequiredFormValue(formData, 'displayName');
    const iconUrl = readOptionalFormValue(formData, 'iconUrl');
    const additionalPrompt = readOptionalFormValue(formData, 'additionalPrompt');
    const { withSql, requireAdminUserId } = await import('./admin-actions-shared.ts');
    await withSql(async (sql) => {
      const userId = await requireAdminUserId();
      await updateProjectActivityPubProfile({
        sql,
        userId,
        projectSlug,
        displayName,
        iconUrl,
        additionalPrompt,
      });
    });
    revalidatePath(`/projects/${projectSlug}/settings`);
    revalidatePath(`/projects/${projectSlug}/admin/settings`);
  } catch (error) {
    throw toSafeActionError(error);
  }
}

function readRequiredFormValue(formData: FormData, key: string): string {
  try {
    return requireFormValue(formData, key);
  } catch {
    throw new ActivityPubProfileAdminError('invalid_body', `${key} is required`, 400);
  }
}

function readOptionalFormValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ActivityPubProfileAdminError('invalid_body', `${key} must be a string`, 400);
  }
  return value;
}

function toSafeActionError(error: unknown): ActivityPubProfileAdminError {
  if (error instanceof ActivityPubProfileAdminError) {
    return error;
  }
  return mapActivityPubProfileAdminError(error).code === 'activitypub_internal_error'
    ? new ActivityPubProfileAdminError('activitypub_internal_error', GENERIC_ACTION_ERROR, 500)
    : mapActivityPubProfileAdminError(error);
}
