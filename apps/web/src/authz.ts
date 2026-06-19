import type postgres from 'postgres';
import { isProjectVisibility, type ProjectVisibility } from './admin-data.ts';

export type ProjectMemberRole = 'admin' | 'member';
export type AppMemberRole = 'admin' | 'member';

export interface ProjectMemberAccess {
  appRole: AppMemberRole;
  description: string | null;
  graphName: string | null;
  id: string;
  name: string;
  projectRole: ProjectMemberRole | null;
  slug: string;
  visibility: ProjectVisibility;
}

export function parseAppUserRoleRow(value: unknown): AppMemberRole {
  if (!isRecord(value)) {
    throw new Error('Invalid app user role row.');
  }
  const role = value.role;
  if (role === 'admin' || role === 'member') {
    return role;
  }
  throw new Error('Invalid app user role row field: role');
}

export function parseProjectMemberAccess(value: unknown): ProjectMemberAccess {
  if (!isRecord(value)) {
    throw new Error('Invalid project member access row.');
  }
  return {
    appRole: parseAppMemberRole(value.appRole, 'appRole'),
    description: parseNullableString(value.description, 'description'),
    graphName: parseNullableString(value.graphName, 'graphName'),
    id: parseRequiredString(value.id, 'id'),
    name: parseRequiredString(value.name, 'name'),
    projectRole: parseNullableProjectMemberRole(value.projectRole, 'projectRole'),
    slug: parseRequiredString(value.slug, 'slug'),
    visibility: parseProjectVisibility(value.visibility, 'visibility'),
  };
}

export async function lookupAppUserRole(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string },
): Promise<AppMemberRole | undefined> {
  const rows = (await sql`
    SELECT role
    FROM public.users
    WHERE id = ${input.userId}
      AND role IN ('admin', 'member')
  `) as readonly unknown[];
  return rows[0] ? parseAppUserRoleRow(rows[0]) : undefined;
}

export async function lookupGlobalAdminUserId(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { userId: string },
): Promise<string | undefined> {
  const role = await lookupAppUserRole(sql, input);
  return role === 'admin' ? input.userId : undefined;
}

export async function lookupProjectMemberAccess(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { projectSlug: string; userId: string },
): Promise<ProjectMemberAccess | undefined> {
  const rows = (await sql`
    SELECT
      p.id::text AS id,
      p.slug,
      p.name,
      p.description,
      p.graph_name AS "graphName",
      COALESCE(p.visibility, 'private') AS visibility,
      app_user.role AS "appRole",
      pm.role AS "projectRole"
    FROM public.projects p
    JOIN public.users app_user
      ON app_user.id = ${input.userId}
    LEFT JOIN public.project_members pm
      ON pm.project_id = p.id
     AND pm.user_id = app_user.id
    WHERE p.slug = ${input.projectSlug}
      AND (app_user.role = 'admin' OR pm.user_id IS NOT NULL)
    LIMIT 1
  `) as readonly unknown[];
  return rows[0] ? parseProjectMemberAccess(rows[0]) : undefined;
}

export async function lookupProjectAdminAccess(
  sql: postgres.Sql | postgres.TransactionSql,
  input: { projectSlug: string; userId: string },
): Promise<ProjectMemberAccess | undefined> {
  const access = await lookupProjectMemberAccess(sql, input);
  if (!access) {
    return undefined;
  }
  return access.appRole === 'admin' || access.projectRole === 'admin' ? access : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid project member access field: ${fieldName}`);
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid project member access field: ${fieldName}`);
}

function parseAppMemberRole(value: unknown, fieldName: string): AppMemberRole {
  if (value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Invalid project member access field: ${fieldName}`);
}

function parseNullableProjectMemberRole(
  value: unknown,
  fieldName: string,
): ProjectMemberRole | null {
  if (value === null || value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Invalid project member access field: ${fieldName}`);
}

function parseProjectVisibility(value: unknown, fieldName: string): ProjectVisibility {
  if (isProjectVisibility(value)) {
    return value;
  }
  throw new Error(`Invalid project member access field: ${fieldName}`);
}
