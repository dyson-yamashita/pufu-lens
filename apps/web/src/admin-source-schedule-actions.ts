'use server';

import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import {
  type DataSourceScheduleSummary,
  readDataSourceSchedule,
  requireDailyTime,
  updateDataSourceScheduleRow,
} from './data-source-schedules.ts';

export async function getDataSourceSchedule(
  projectSlug: string,
  dataSourceId: string,
): Promise<DataSourceScheduleSummary | null> {
  return withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    return readDataSourceSchedule(sql, { dataSourceId, projectId: project.id });
  });
}

export async function updateDataSourceSchedule(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');
  const dailyTime = requireDailyTime(requireFormValue(formData, 'dailyTime'));
  const enabled = formData.get('enabled')?.toString() === 'on';
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const updated = await updateDataSourceScheduleRow(sql, {
      dailyTime,
      dataSourceId,
      enabled,
      projectId: project.id,
    });
    if (!updated) throw new Error('Data source schedule was not found in this project.');
  });
  revalidateProject(projectSlug);
}
