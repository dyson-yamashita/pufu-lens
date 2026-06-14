import type { AppMemberRole } from './admin-db';

export function parseAppMemberRoleRow(value: unknown): AppMemberRole {
  if (!isRecord(value) || (value.role !== 'admin' && value.role !== 'member')) {
    throw new Error('Invalid app member role row.');
  }
  return value.role;
}

export function parseCanManageProjectRow(value: unknown): boolean {
  if (!isRecord(value) || typeof value.can_manage !== 'boolean') {
    throw new Error('Invalid project management access row.');
  }
  return value.can_manage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
