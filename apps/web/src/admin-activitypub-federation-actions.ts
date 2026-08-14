'use server';

import { revalidatePath } from 'next/cache';
import { ActivityPubAdminError, patchProjectFederation } from './activitypub-admin.ts';
import { parseFederationEnabledFormValue } from './activitypub-federation-form.ts';
import { requireFormValue } from './admin-actions-shared.ts';

const GENERIC_ACTION_ERROR = 'Unable to update ActivityPub federation. Try again later.';

/**
 * Enables or disables ActivityPub federation for the authenticated project admin's project actor.
 *
 * @param formData - Form values containing `projectSlug` and exact-string `enabled` (`true` or `false`).
 * @throws {ActivityPubAdminError} For invalid input or sanitized federation authorization / validation failures.
 */
export async function setProjectFederationEnabled(formData: FormData): Promise<void> {
  try {
    const projectSlug = readRequiredAdminFormValue(formData, 'projectSlug');
    const enabled = parseFederationEnabledFormValue(
      readRequiredAdminFormValue(formData, 'enabled'),
    );

    const { withSql, requireAdminUserId } = await import('./admin-actions-shared.ts');
    await withSql(async (sql) => {
      const userId = await requireAdminUserId();
      await patchProjectFederation({
        sql,
        userId,
        projectSlug,
        body: { enabled },
      });
    });

    revalidateProjectFederationPaths(projectSlug);
  } catch (error) {
    throw toSafeActionError(error);
  }
}

function readRequiredAdminFormValue(formData: FormData, key: string): string {
  try {
    return requireFormValue(formData, key);
  } catch {
    throw new ActivityPubAdminError('invalid_body', `${key} is required`, 400);
  }
}

function revalidateProjectFederationPaths(projectSlug: string): void {
  revalidatePath(`/projects/${projectSlug}/settings`);
  revalidatePath(`/projects/${projectSlug}/admin/settings`);
}

function toSafeActionError(error: unknown): ActivityPubAdminError {
  if (error instanceof ActivityPubAdminError) {
    return error;
  }
  return new ActivityPubAdminError('activitypub_internal_error', GENERIC_ACTION_ERROR, 500);
}
