'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type postgres from 'postgres';
import {
  deriveProjectIdentifiers,
  validateProjectSlug,
} from '../../../packages/project-tenancy/src/project-tenancy.ts';
import { type AdminActionIdRow, parseAdminActionIdRow } from './admin-actions-guards.ts';
import {
  parseOptionalAdminActionRow,
  requireAdminProject,
  requireFormValue,
  requireGlobalAdmin,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import { isProjectVisibility, type ProjectVisibility } from './admin-data';
import { deleteProjectUseCase } from './delete-project-use-case.ts';
import {
  HYBRID_SEARCH_DOCUMENT_LIMIT_SETTING_KEY,
  requireHybridSearchDocumentLimit,
} from './project-chat-settings.ts';
import { saveGithubAppConnectionConfig } from './project-connections';
import { ensureProjectStoragePrefixes } from './project-storage-cleanup.ts';
import { writePublicProjectVisibilityManifest } from './project-visibility-manifest.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

async function projectSlugExists(sql: SqlExecutor, slug: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM public.projects WHERE slug = ${slug}
  `) as readonly unknown[];
  return rows.length > 0;
}

function parseOptionalAdminActionIdRow(
  rows: readonly unknown[],
  context: string,
): AdminActionIdRow | undefined {
  return parseOptionalAdminActionRow(rows, (row) => parseAdminActionIdRow(row, context));
}

async function insertCreatedProjectRow(
  sql: SqlExecutor,
  {
    description,
    graphName,
    name,
    slug,
    storagePrefix,
    visibility,
  }: {
    readonly description: string | null;
    readonly graphName: string;
    readonly name: string;
    readonly slug: string;
    readonly storagePrefix: string;
    readonly visibility: ProjectVisibility;
  },
): Promise<AdminActionIdRow | undefined> {
  const rows = (await sql`
    INSERT INTO public.projects (slug, name, description, graph_name, storage_prefix, visibility)
    VALUES (
      ${slug},
      ${name},
      ${description},
      ${graphName},
      ${storagePrefix},
      ${visibility}
    )
    RETURNING id::text
  `) as readonly unknown[];
  return parseOptionalAdminActionIdRow(rows, 'project creation row');
}

export async function createProject(formData: FormData): Promise<void> {
  const name = requireFormValue(formData, 'name').trim();
  if (!name) {
    throw new Error('name is required.');
  }
  const slug = validateProjectSlug(requireFormValue(formData, 'slug').trim());
  const description = formData.get('description')?.toString().trim() || null;
  const visibility = requireProjectVisibility(
    formData.get('visibility')?.toString().trim() || 'private',
  );
  const identifiers = deriveProjectIdentifiers(slug);

  await withSql(async (sql) => {
    const adminUserId = await requireGlobalAdmin(sql);
    await sql.begin(async (tx) => {
      await tx`LOAD 'age'`;
      await tx`SET LOCAL search_path = ag_catalog, "$user", public`;

      if (await projectSlugExists(tx, slug)) {
        throw new Error(`Project slug already exists: ${slug}`);
      }

      const project = await insertCreatedProjectRow(tx, {
        description,
        graphName: identifiers.graphName,
        name,
        slug,
        storagePrefix: identifiers.storagePrefix,
        visibility,
      });
      if (!project) {
        throw new Error('Project creation failed.');
      }

      await tx`
        INSERT INTO public.project_members (project_id, user_id, role)
        VALUES (${project.id}, ${adminUserId}, 'admin')
        ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'admin'
      `;

      await tx`
        SELECT create_graph(${identifiers.graphName})
        WHERE NOT EXISTS (
          SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${identifiers.graphName}
        )
      `;
    });
  });

  await ensureProjectStoragePrefixes(slug);
  await writePublicProjectVisibilityManifest(slug, visibility);
  revalidatePath('/projects');
}

export async function updateProjectVisibility(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const visibility = requireProjectVisibility(requireFormValue(formData, 'visibility'));

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await applyProjectVisibilityChange(
      project,
      visibility,
      async () => {
        await updateProjectVisibilityRow(sql, project.id, visibility);
      },
      async () => {
        await updateProjectVisibilityRow(sql, project.id, project.visibility);
      },
    );
  });

  revalidateProject(projectSlug);
}

/**
 * Updates a project's name, description, visibility, and hybrid-search document limit.
 *
 * @param formData - Form data containing the project fields and bounded hybrid-search limit
 */
export async function updateProjectSettings(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const name = requireFormValue(formData, 'name').trim();
  if (!name) {
    throw new Error('name is required.');
  }
  const description = formData.get('description')?.toString().trim() || null;
  const visibility = requireProjectVisibility(requireFormValue(formData, 'visibility'));
  const hybridSearchDocumentLimit = requireHybridSearchDocumentLimit(
    requireFormValue(formData, 'hybridSearchDocumentLimit'),
  );

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const settings = { description, hybridSearchDocumentLimit, name, visibility };

    if (visibility === project.visibility) {
      await updateProjectSettingsRow(sql, project.id, settings);
      return;
    }

    await applyProjectVisibilityChange(
      project,
      visibility,
      async () => {
        await updateProjectSettingsRow(sql, project.id, settings);
      },
      async () => {
        await updateProjectSettingsRow(sql, project.id, {
          description: project.description,
          hybridSearchDocumentLimit: project.hybridSearchDocumentLimit,
          name: project.name,
          visibility: project.visibility,
        });
      },
    );
  });

  revalidateProject(projectSlug);
}

/**
 * Deletes a project after the confirmation name matches.
 *
 * @param formData - Form data containing `projectSlug` and `confirmationProjectName`
 */
export async function deleteProject(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const confirmationProjectName = requireFormValue(formData, 'confirmationProjectName').trim();
  let storageCleanupWarning: string | undefined;

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    if (confirmationProjectName !== project.name.trim()) {
      throw new Error('Project name confirmation does not match.');
    }

    ({ storageCleanupWarning } = await deleteProjectUseCase(sql, project));
  });

  if (storageCleanupWarning) {
    console.warn(storageCleanupWarning);
  }
  revalidateProject(projectSlug);
  redirect('/projects');
}

/**
 * Updates the GitHub App connection settings for a project.
 */
export async function updateGithubAppConnectionSettings(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const appSlug = requireFormValue(formData, 'githubAppSlug');
  const appId = requireFormValue(formData, 'githubAppId');
  const privateKey = formData.get('githubAppPrivateKey')?.toString() ?? '';
  await saveGithubAppConnectionConfig({
    appId,
    appSlug,
    privateKey,
    projectSlug,
  });
  revalidateProject(projectSlug);
}

function requireProjectVisibility(value: string): ProjectVisibility {
  if (isProjectVisibility(value)) {
    return value;
  }
  throw new Error(`Unsupported project visibility: ${value}`);
}

async function applyProjectVisibilityChange(
  project: {
    readonly id: string;
    readonly slug: string;
    readonly visibility: ProjectVisibility;
  },
  visibility: ProjectVisibility,
  updateRow: () => Promise<void>,
  rollbackRow: () => Promise<void>,
): Promise<void> {
  if (visibility === 'private') {
    await writePublicProjectVisibilityManifest(project.slug, visibility);
    try {
      await updateRow();
    } catch (error) {
      try {
        await writePublicProjectVisibilityManifest(project.slug, project.visibility);
      } catch (rollbackError) {
        console.error('Failed to rollback public project visibility manifest:', rollbackError);
      }
      throw error;
    }
    return;
  }

  await updateRow();
  try {
    await writePublicProjectVisibilityManifest(project.slug, visibility);
  } catch (error) {
    try {
      await rollbackRow();
    } catch (rollbackError) {
      console.error('Failed to rollback project visibility row:', rollbackError);
    }
    throw error;
  }
}

async function updateProjectVisibilityRow(
  sql: postgres.Sql,
  projectId: string,
  visibility: ProjectVisibility,
): Promise<void> {
  await sql`
    UPDATE public.projects
    SET visibility = ${visibility},
        updated_at = now()
    WHERE id = ${projectId}
  `;
}

async function updateProjectSettingsRow(
  sql: postgres.Sql,
  projectId: string,
  input: {
    readonly description: string | null;
    readonly hybridSearchDocumentLimit: number;
    readonly name: string;
    readonly visibility: ProjectVisibility;
  },
): Promise<void> {
  await sql`
    UPDATE public.projects
    SET name = ${input.name},
        description = ${input.description},
        visibility = ${input.visibility},
        settings = jsonb_set(
          settings,
          ARRAY[${HYBRID_SEARCH_DOCUMENT_LIMIT_SETTING_KEY}],
          to_jsonb(${input.hybridSearchDocumentLimit}::int),
          true
        ),
        updated_at = now()
    WHERE id = ${projectId}
  `;
}
