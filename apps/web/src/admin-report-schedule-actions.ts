'use server';

import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import { requireSessionUserId } from './auth-session.ts';
import { lookupProjectMemberAccess } from './authz.ts';
import {
  type ProjectReportScheduleSettingsView,
  parseReportScheduleFrequencyInput,
  readProjectReportScheduleSettings,
  saveProjectReportSchedule,
} from './report-schedule-settings.ts';

/**
 * Retrieves report schedule settings for a project the current user can access.
 *
 * @param projectSlug - The project's unique slug
 * @returns The project's report schedule settings, or `null` if the user is unauthenticated or lacks access
 */
export async function getProjectReportScheduleSettings(
  projectSlug: string,
): Promise<ProjectReportScheduleSettingsView | null> {
  return withSql(async (sql) => {
    let userId: string;
    try {
      userId = await requireSessionUserId();
    } catch {
      return null;
    }
    const access = await lookupProjectMemberAccess(sql, { projectSlug, userId });
    if (!access) {
      return null;
    }
    return readProjectReportScheduleSettings(sql, { projectId: access.id });
  });
}

/**
 * Updates a project's report schedule settings from submitted form data.
 *
 * @param formData - Form data containing the project slug and report schedule frequency
 */
export async function updateProjectReportSchedule(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const frequency = parseReportScheduleFrequencyInput(requireFormValue(formData, 'frequency'));
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await saveProjectReportSchedule(sql, {
      asOf: new Date(),
      frequency,
      projectId: project.id,
      updatedBy: project.adminUserId,
    });
  });
  revalidateProject(projectSlug);
}
