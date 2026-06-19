import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import type { ProjectVisibility } from './admin-data';
import { getRequiredAdminSql } from './admin-sql';
import { requireSessionUserId } from './auth-session';
import { lookupGlobalAdminUserId, lookupProjectAdminAccess } from './authz.ts';

export async function requireGlobalAdmin(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<string> {
  const userId = await requireSessionUserId();
  const adminUserId = await lookupGlobalAdminUserId(sql, { userId });
  if (!adminUserId) {
    throw new Error('Admin access is required.');
  }
  return adminUserId;
}

export async function withSql<T>(callback: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  return callback(getRequiredAdminSql());
}

export async function requireAdminUserId(): Promise<string> {
  const sessionUserId = await requireSessionUserId();
  if (sessionUserId) {
    return sessionUserId;
  }
  throw new Error('Authentication is required for admin actions.');
}

export async function requireAdminProject(
  sql: postgres.Sql | postgres.TransactionSql,
  projectSlug: string,
): Promise<{
  readonly adminUserId: string;
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
}> {
  const adminUserId = await requireAdminUserId();
  const access = await lookupProjectAdminAccess(sql, { projectSlug, userId: adminUserId });
  if (!access) {
    throw new Error(`Admin access denied for project slug: ${projectSlug}`);
  }
  return {
    adminUserId,
    description: access.description,
    id: access.id,
    name: access.name,
    slug: access.slug,
    visibility: access.visibility,
  };
}

export function requireFormValue(formData: FormData, key: string): string {
  const value = formData.get(key)?.toString();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

export function revalidateProject(projectSlug: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectSlug}`);
  revalidatePath(`/projects/${projectSlug}/chat`);
  revalidatePath(`/projects/${projectSlug}/graph`);
  revalidatePath(`/projects/${projectSlug}/members`);
  revalidatePath(`/projects/${projectSlug}/admin/data-sources`);
  revalidatePath(`/projects/${projectSlug}/admin/parser-profiles`);
  revalidatePath(`/projects/${projectSlug}/admin/settings`);
  revalidatePath(`/projects/${projectSlug}/reports`);
}
