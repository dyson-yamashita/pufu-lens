import type { AppMemberRole, ProjectMemberRole } from './admin-db';

export type AdminDbAppMemberRow = {
  readonly created_at: Date | string;
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly role: AppMemberRole;
};

export type AdminDbProjectMemberRow = AdminDbAppMemberRow & {
  readonly membership_created_at: Date | string | null;
  readonly project_role: ProjectMemberRole;
  readonly removable: boolean;
};

export function parseAdminDbIdRow(value: unknown, context: string): string {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const id = value.id;
  if (typeof id !== 'string') {
    throw new Error(`Invalid ${context} row field: id`);
  }
  return id;
}

export function parseAppMemberRoleRow(value: unknown): AppMemberRole {
  if (!isRecord(value)) {
    throw new Error('Invalid app member role row.');
  }
  const role = value.role;
  if (role !== 'admin' && role !== 'member') {
    throw new Error('Invalid app member role row.');
  }
  return role;
}

export function parseAdminDbAppMemberRow(
  value: unknown,
  context = 'app member',
): AdminDbAppMemberRow {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { created_at, email, id, name, role } = value;
  return {
    created_at: parseDateLike(created_at, context, 'created_at'),
    email: parseRequiredString(email, context, 'email'),
    id: parseRequiredString(id, context, 'id'),
    name: parseNullableString(name, context, 'name'),
    role: parseMemberRole(role, context, 'role'),
  };
}

export function parseAdminDbProjectMemberRow(value: unknown): AdminDbProjectMemberRow {
  if (!isRecord(value)) {
    throw new Error('Invalid project member row.');
  }
  const { membership_created_at, project_role, removable } = value;
  return {
    ...parseAdminDbAppMemberRow(value, 'project member'),
    membership_created_at: parseNullableDateLike(
      membership_created_at,
      'project member',
      'membership_created_at',
    ),
    project_role: parseMemberRole(project_role, 'project member', 'project_role'),
    removable: parseBoolean(removable, 'project member', 'removable'),
  };
}

export function parseCanManageProjectRow(value: unknown): boolean {
  if (!isRecord(value)) {
    throw new Error('Invalid project management access row.');
  }
  const canManage = value.can_manage;
  if (typeof canManage !== 'boolean') {
    throw new Error('Invalid project management access row.');
  }
  return canManage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, context: string, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${context} row field: ${fieldName}`);
  }
  return value;
}

function parseNullableString(value: unknown, context: string, fieldName: string): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseDateLike(value: unknown, context: string, fieldName: string): Date | string {
  if (value instanceof Date || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseNullableDateLike(
  value: unknown,
  context: string,
  fieldName: string,
): Date | string | null {
  if (value === null || value instanceof Date || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseBoolean(value: unknown, context: string, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseMemberRole(value: unknown, context: string, fieldName: string): AppMemberRole {
  if (value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}
