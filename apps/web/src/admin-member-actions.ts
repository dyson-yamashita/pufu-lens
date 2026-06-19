'use server';

import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import { type AdminActionIdRow, parseAdminActionIdRow } from './admin-actions-guards.ts';
import { requireFormValue, requireGlobalAdmin, withSql } from './admin-actions-shared.ts';
import type { AppMemberRole } from './admin-db';
import { requireSessionUserId } from './auth-session';
import { assertOtherGlobalAdminExists, lookupProjectAdminAccess } from './authz.ts';
import { hashPassword } from './password-auth';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export async function createMember(formData: FormData): Promise<void> {
  const email = normalizeEmail(requireFormValue(formData, 'email'));
  const name = formData.get('name')?.toString().trim() || null;
  const role = requireAppMemberRole(requireFormValue(formData, 'role'));
  const password = formData.get('password')?.toString() ?? '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() ?? '';

  if (!isValidEmail(email)) {
    throw new Error('Invalid email address.');
  }
  validateOptionalPassword(password, passwordConfirm);

  await withSql(async (sql) => {
    await requireGlobalAdmin(sql);
    await sql.begin(async (tx) => {
      const user = await insertCreatedMemberRow(tx, { email, name, role });
      if (!user) {
        throw new Error('Member creation failed.');
      }
      if (password) {
        const passwordHash = await hashPassword(password);
        await tx`
          INSERT INTO public.auth_password_credentials (user_id, password_hash)
          VALUES (${user.id}, ${passwordHash})
          ON CONFLICT (user_id)
          DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
        `;
      }
    });
  });

  revalidatePath('/members');
}

export async function updateMember(formData: FormData): Promise<void> {
  const userId = requireFormValue(formData, 'userId');
  const name = formData.get('name')?.toString().trim() || null;
  const role = requireAppMemberRole(requireFormValue(formData, 'role'));
  const password = formData.get('password')?.toString() ?? '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() ?? '';

  validateOptionalPassword(password, passwordConfirm);

  await withSql(async (sql) => {
    await requireGlobalAdmin(sql);
    await sql.begin(async (tx) => {
      if (role === 'member') {
        await assertAdminRemainsAfterRoleChange(tx, userId);
      }
      await tx`
        UPDATE public.users
        SET name = ${name},
            role = ${role}
        WHERE id = ${userId}
      `;
      if (password) {
        const passwordHash = await hashPassword(password);
        await tx`
          INSERT INTO public.auth_password_credentials (user_id, password_hash)
          VALUES (${userId}, ${passwordHash})
          ON CONFLICT (user_id)
          DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
        `;
      }
    });
  });

  revalidatePath('/members');
  revalidatePath('/projects');
}

export async function addProjectMember(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const userId = requireFormValue(formData, 'userId');

  await withSql(async (sql) => {
    const project = await requireProjectAdminForMemberManagement(sql, projectSlug);
    await sql`
      INSERT INTO public.project_members (project_id, user_id, role)
      VALUES (${project.id}, ${userId}, 'member')
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET role = 'member'
    `;
  });

  revalidatePath(`/projects/${projectSlug}/members`);
  revalidatePath('/projects');
}

export async function removeProjectMember(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const userId = requireFormValue(formData, 'userId');

  await withSql(async (sql) => {
    const project = await requireProjectAdminForMemberManagement(sql, projectSlug);
    await sql`
      DELETE FROM public.project_members
      USING public.users
      WHERE project_members.project_id = ${project.id}
        AND project_members.user_id = ${userId}
        AND users.id = project_members.user_id
        AND users.role <> 'admin'
        AND project_members.role = 'member'
    `;
  });

  revalidatePath(`/projects/${projectSlug}/members`);
  revalidatePath('/projects');
}

function parseOptionalAdminActionIdRow(
  rows: readonly unknown[],
  context: string,
): AdminActionIdRow | undefined {
  return rows[0] ? parseAdminActionIdRow(rows[0], context) : undefined;
}

async function insertCreatedMemberRow(
  sql: SqlExecutor,
  {
    email,
    name,
    role,
  }: {
    readonly email: string;
    readonly name: string | null;
    readonly role: AppMemberRole;
  },
): Promise<AdminActionIdRow | undefined> {
  const rows = (await sql`
    INSERT INTO public.users (email, name, role)
    VALUES (${email}, ${name}, ${role})
    RETURNING id::text
  `) as readonly unknown[];
  return parseOptionalAdminActionIdRow(rows, 'member creation row');
}

async function assertAdminRemainsAfterRoleChange(
  sql: postgres.TransactionSql,
  userId: string,
): Promise<void> {
  await assertOtherGlobalAdminExists(sql, { userId });
}

async function requireProjectAdminForMemberManagement(
  sql: postgres.Sql | postgres.TransactionSql,
  projectSlug: string,
): Promise<{
  readonly id: string;
  readonly slug: string;
}> {
  const userId = await requireSessionUserId();
  const project = await lookupProjectAdminAccess(sql, { projectSlug, userId });
  if (!project) {
    throw new Error(`Member management denied for project slug: ${projectSlug}`);
  }
  return { id: project.id, slug: project.slug };
}

function requireAppMemberRole(value: string): AppMemberRole {
  if (value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Unsupported member role: ${value}`);
}

function validateOptionalPassword(password: string, passwordConfirm: string): void {
  if (!password && !passwordConfirm) {
    return;
  }
  if (password !== passwordConfirm) {
    throw new Error('password confirmation does not match.');
  }
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters.');
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
