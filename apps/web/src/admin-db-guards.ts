import { isProjectVisibility, type ProjectVisibility } from './admin-data.ts';
import type { AppMemberRole, ProjectMemberRole } from './admin-db';

export type AdminDbProjectRow = {
  readonly description: string | null;
  readonly failed_count: number | string | bigint;
  readonly held_count: number | string | bigint;
  readonly id: string;
  readonly ingested_count: number | string | bigint;
  readonly last_indexed: Date | string | null;
  readonly member_count: number | string | bigint;
  readonly name: string;
  readonly queue_count: number | string | bigint;
  readonly raw_count: number | string | bigint;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
};

export type AdminDbPublicProjectReportRow = {
  readonly description: string | null;
  readonly name: string;
  readonly published_at: Date | string | null;
  readonly report_id: string | null;
  readonly report_summary: string | null;
  readonly report_title: string | null;
  readonly slug: string;
};

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

export function parseAdminDbProjectRow(value: unknown): AdminDbProjectRow {
  const context = 'project';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const {
    description,
    failed_count,
    held_count,
    id,
    ingested_count,
    last_indexed,
    member_count,
    name,
    queue_count,
    raw_count,
    slug,
    visibility,
  } = value;
  return {
    description: parseNullableString(description, context, 'description'),
    failed_count: parseCountLike(failed_count, context, 'failed_count'),
    held_count: parseCountLike(held_count, context, 'held_count'),
    id: parseRequiredString(id, context, 'id'),
    ingested_count: parseCountLike(ingested_count, context, 'ingested_count'),
    last_indexed: parseNullableDateLike(last_indexed, context, 'last_indexed'),
    member_count: parseCountLike(member_count, context, 'member_count'),
    name: parseRequiredString(name, context, 'name'),
    queue_count: parseCountLike(queue_count, context, 'queue_count'),
    raw_count: parseCountLike(raw_count, context, 'raw_count'),
    slug: parseRequiredString(slug, context, 'slug'),
    visibility: parseProjectVisibility(visibility, context, 'visibility'),
  };
}

export function parseAdminDbPublicProjectReportRow(value: unknown): AdminDbPublicProjectReportRow {
  const context = 'public project report';
  if (!isRecord(value)) {
    throw new Error(`Invalid ${context} row.`);
  }
  const { description, name, published_at, report_id, report_summary, report_title, slug } = value;
  return {
    description: parseNullableString(description, context, 'description'),
    name: parseRequiredString(name, context, 'name'),
    published_at: parseNullableDateLike(published_at, context, 'published_at'),
    report_id: parseNullableString(report_id, context, 'report_id'),
    report_summary: parseNullableString(report_summary, context, 'report_summary'),
    report_title: parseNullableString(report_title, context, 'report_title'),
    slug: parseRequiredString(slug, context, 'slug'),
  };
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
  return value === null ? null : parseRequiredString(value, context, fieldName);
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
  return value === null ? null : parseDateLike(value, context, fieldName);
}

function parseBoolean(value: unknown, context: string, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseMemberRole(value: unknown, context: string, fieldName: string): 'admin' | 'member' {
  if (value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseCountLike(
  value: unknown,
  context: string,
  fieldName: string,
): number | string | bigint {
  if (
    (typeof value === 'number' && Number.isInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^\d+$/.test(value)) ||
    (typeof value === 'bigint' && value >= 0n)
  ) {
    return value;
  }
  throw new Error(`Invalid ${context} row field: ${fieldName}`);
}

function parseProjectVisibility(
  value: unknown,
  context: string,
  fieldName: string,
): ProjectVisibility {
  if (!isProjectVisibility(value)) {
    throw new Error(`Invalid ${context} row field: ${fieldName}`);
  }
  return value;
}
