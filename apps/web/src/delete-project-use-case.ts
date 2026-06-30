import type postgres from 'postgres';
import type { ProjectVisibility } from './admin-data';
import {
  formatProjectStorageCleanupFailure,
  prepareProjectStorageCleanup,
} from './project-storage-cleanup.ts';
import { writePublicProjectVisibilityManifest } from './project-visibility-manifest.ts';

export interface DeletableProject {
  readonly graphName: string | null;
  readonly id: string;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
}

export interface DeleteProjectUseCaseResult {
  readonly storageCleanupWarning?: string;
}

export async function deleteProjectUseCase(
  sql: postgres.Sql,
  project: DeletableProject,
): Promise<DeleteProjectUseCaseResult> {
  const cleanupProjectStorage = await prepareProjectStorageCleanup(project.slug);

  await writePublicProjectVisibilityManifest(project.slug, 'private');

  try {
    await sql.begin(async (tx) => {
      await tx`LOAD 'age'`;
      await tx`SET LOCAL search_path = ag_catalog, "$user", public`;

      if (project.graphName) {
        const graphRows = await tx`
          SELECT 1
          FROM ag_catalog.ag_graph
          WHERE name = ${project.graphName}
        `;
        if (graphRows.length > 0) {
          await tx`SELECT drop_graph(${project.graphName}, ${true})`;
        }
      }

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
