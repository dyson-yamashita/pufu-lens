import type { GraphMutationRepository } from '@pufu-lens/graph';
import type postgres from 'postgres';
import type { ProjectVisibility } from './admin-data';
import {
  formatProjectStorageCleanupFailure,
  prepareProjectStorageCleanup,
} from './project-storage-cleanup.ts';
import { writePublicProjectVisibilityManifest } from './project-visibility-manifest.ts';

export interface DeletableProject {
  readonly id: string;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
}

/** Creates a graph mutation repository bound to the caller's open transaction. */
export type CreateGraphMutationRepository = (
  tx: postgres.TransactionSql,
) => GraphMutationRepository;

export interface DeleteProjectUseCaseResult {
  readonly storageCleanupWarning?: string;
}

/**
 * Deletes a project and its graph after manifest preparation, within one relational transaction.
 *
 * @param sql - Postgres client used for the atomic delete transaction.
 * @param project - Relational project identity and visibility used for rollback.
 * @param createMutationRepository - Factory that binds graph mutations to the open transaction.
 */
export async function deleteProjectUseCase(
  sql: postgres.Sql,
  project: DeletableProject,
  createMutationRepository: CreateGraphMutationRepository,
): Promise<DeleteProjectUseCaseResult> {
  const cleanupProjectStorage = await prepareProjectStorageCleanup(project.slug);

  await writePublicProjectVisibilityManifest(project.slug, 'private');

  try {
    await sql.begin(async (tx) => {
      const mutationRepository = createMutationRepository(tx);
      await mutationRepository.deleteProjectGraph({ projectId: project.id });

      await tx`
        DELETE FROM public.projects
        WHERE id = ${project.id}
      `;
    });
  } catch (error) {
    try {
      await writePublicProjectVisibilityManifest(project.slug, project.visibility);
    } catch (rollbackError) {
      console.error('Failed to rollback public project visibility manifest:', rollbackError);
    }
    throw error;
  }

  try {
    const storageCleanupResult = await cleanupProjectStorage();
    if (storageCleanupResult.failedCount > 0) {
      return {
        storageCleanupWarning: formatProjectStorageCleanupFailure(storageCleanupResult),
      };
    }
  } catch (error) {
    return {
      storageCleanupWarning: `Project storage cleanup failed for ${project.slug}: ${summarizeCleanupError(error)}`,
    };
  }

  return {};
}

function summarizeCleanupError(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return typeof error;
}
