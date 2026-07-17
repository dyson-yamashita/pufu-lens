'use server';

import { revalidateProject, withSql } from './admin-actions-shared.ts';
import {
  parseProjectReportScheduleSaveInput,
  readProjectReportScheduleSettingsForUser,
  resolveReportScheduleSettingsUserId,
  saveProjectReportScheduleForAdmin,
} from './admin-report-schedule-runtime.ts';
import { requireSessionUserId } from './auth-session.ts';
import type { ProjectReportScheduleSettingsView } from './report-schedule-presentation.ts';

export type { ProjectReportScheduleSettingsView } from './report-schedule-presentation.ts';

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
    const userId = await resolveReportScheduleSettingsUserId(() => requireSessionUserId());
    if (!userId) {
      return null;
    }
    return readProjectReportScheduleSettingsForUser(sql, { projectSlug, userId });
  });
}

/**
 * Updates a project's report schedule settings from submitted form data.
 *
 * Requires project-admin access for the submitted slug and persists the schedule inside
 * the same authorization helper used by runtime integration tests.
 *
 * @param formData - Form data containing the project slug and report schedule frequency
 */
export async function updateProjectReportSchedule(formData: FormData): Promise<void> {
  const { frequency, projectSlug } = parseProjectReportScheduleSaveInput(formData);
  await withSql(async (sql) => {
    const userId = await requireSessionUserId();
    await saveProjectReportScheduleForAdmin(sql, {
      asOf: new Date(),
      frequency,
      projectSlug,
      userId,
    });
  });
  revalidateProject(projectSlug);
}
