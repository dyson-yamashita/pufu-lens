import type postgres from 'postgres';
import { AuthRequiredError } from './auth-errors.ts';
import {
  lookupProjectAdminAccess,
  lookupProjectMemberAccess,
  type ProjectMemberAccess,
} from './authz.ts';
import type { ReportScheduleFrequency } from './report-schedule-contract.ts';
import type { ProjectReportScheduleSettingsView } from './report-schedule-presentation.ts';
import {
  parseReportScheduleFrequencyInput,
  readProjectReportScheduleSettings,
  saveProjectReportSchedule,
} from './report-schedule-settings.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/**
 * Reports-page access for schedule settings.
 *
 * Members may read `scheduleSettings`; only project admins receive `adminAccess` for saves.
 */
export interface ReportSchedulePageAccess {
  readonly adminAccess: ProjectMemberAccess | undefined;
  readonly memberAccess: ProjectMemberAccess | undefined;
  readonly scheduleSettings: ProjectReportScheduleSettingsView | null;
}

/**
 * Resolves the authenticated user id for read-only report schedule settings.
 *
 * Returns `null` only for missing sessions (`AuthRequiredError`). Unexpected auth or
 * configuration failures from the injected resolver are rethrown.
 */
export async function resolveReportScheduleSettingsUserId(
  resolveUserId: () => Promise<string>,
): Promise<string | null> {
  try {
    return await resolveUserId();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return null;
    }
    throw error;
  }
}

/**
 * Loads report schedule settings for a project member or global admin.
 *
 * Uses `lookupProjectMemberAccess`; callers without project membership receive `null`
 * instead of an error.
 */
export async function readProjectReportScheduleSettingsForUser(
  sql: SqlExecutor,
  input: { readonly projectSlug: string; readonly userId: string },
): Promise<ProjectReportScheduleSettingsView | null> {
  const access = await lookupProjectMemberAccess(sql, input);
  if (!access) {
    return null;
  }
  return readProjectReportScheduleSettings(sql, { projectId: access.id });
}

/**
 * Saves report schedule settings for a project admin.
 *
 * This is the shared authorization and persistence entrypoint used by the production
 * `updateProjectReportSchedule` server action and runtime integration tests.
 *
 * @throws Error when the user lacks admin access to the submitted project slug
 */
export async function saveProjectReportScheduleForAdmin(
  sql: postgres.Sql,
  input: {
    readonly asOf: Date;
    readonly frequency: ReportScheduleFrequency;
    readonly projectSlug: string;
    readonly userId: string;
  },
): Promise<void> {
  const access = await lookupProjectAdminAccess(sql, {
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!access) {
    throw new Error(`Admin access denied for project slug: ${input.projectSlug}`);
  }
  await saveProjectReportSchedule(sql, {
    asOf: input.asOf,
    frequency: input.frequency,
    projectId: access.id,
    updatedBy: input.userId,
  });
}

/**
 * Resolves report schedule page visibility and management access for a user.
 *
 * Members receive settings for read-only display. Only project admins receive
 * `adminAccess`, which gates the editable schedule form.
 */
export async function resolveReportSchedulePageAccess(
  sql: SqlExecutor,
  input: { readonly projectSlug: string; readonly userId: string | undefined },
): Promise<ReportSchedulePageAccess> {
  if (!input.userId) {
    return {
      adminAccess: undefined,
      memberAccess: undefined,
      scheduleSettings: null,
    };
  }

  const [adminAccess, memberAccess] = await Promise.all([
    lookupProjectAdminAccess(sql, { projectSlug: input.projectSlug, userId: input.userId }),
    lookupProjectMemberAccess(sql, { projectSlug: input.projectSlug, userId: input.userId }),
  ]);
  const scheduleSettings = memberAccess
    ? await readProjectReportScheduleSettings(sql, { projectId: memberAccess.id })
    : null;

  return {
    adminAccess,
    memberAccess,
    scheduleSettings,
  };
}

/**
 * Parses submitted form data into a validated report schedule save request.
 */
export function parseProjectReportScheduleSaveInput(formData: FormData): {
  readonly frequency: ReportScheduleFrequency;
  readonly projectSlug: string;
} {
  return {
    frequency: parseReportScheduleFrequencyInput(requireFormValue(formData, 'frequency')),
    projectSlug: requireFormValue(formData, 'projectSlug'),
  };
}

function requireFormValue(formData: FormData, key: string): string {
  const value = formData.get(key)?.toString();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}
