'use server';

import { revalidatePath } from 'next/cache';
import { executeActorMerge } from './actor-merge-use-case.ts';
import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';

/**
 * Merges a secondary actor into a primary actor for an admin project.
 *
 * @param formData - Form values containing project slug, actor ids, and optional reason.
 * @throws When validation, authorization, or the atomic merge transaction fails.
 */
export async function mergeActors(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const primaryActorId = requireFormValue(formData, 'primaryActorId');
  const secondaryActorId = requireFormValue(formData, 'secondaryActorId');
  const reason = optionalFormValue(formData, 'reason');

  if (primaryActorId === secondaryActorId) {
    throw new Error('Cannot merge an actor into itself.');
  }

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql.begin(async (tx) => {
      await executeActorMerge(tx, {
        adminUserId: project.adminUserId,
        graphName: project.graphName,
        primaryActorId,
        projectId: project.id,
        reason,
        secondaryActorId,
      });
    });
  });

  revalidateActorPaths(projectSlug, primaryActorId, secondaryActorId);
}

function optionalFormValue(formData: FormData, key: string): string | null {
  const value = formData.get(key)?.toString().trim();
  return value ? value : null;
}

function revalidateActorPaths(
  projectSlug: string,
  primaryActorId: string,
  secondaryActorId: string,
): void {
  revalidateProject(projectSlug);
  revalidatePath(`/projects/${projectSlug}/admin/actors/${primaryActorId}`);
  revalidatePath(`/projects/${projectSlug}/admin/actors/${secondaryActorId}`);
}
