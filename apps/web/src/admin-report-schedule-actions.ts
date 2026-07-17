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
