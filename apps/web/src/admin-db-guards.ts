import type { AppMemberRole } from './admin-db';

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
