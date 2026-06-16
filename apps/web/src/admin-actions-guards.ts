import {
  isProjectVisibility,
  isSourceType,
  type ProjectVisibility,
  type SourceType,
} from './admin-data.ts';

export interface AdminActionIdRow {
  readonly id: string;
}

export interface AdminActionDataSourceRow {
  readonly id: string;
  readonly source_type: SourceType;
}

export interface AdminActionDataSourceIngestRow extends AdminActionDataSourceRow {
  readonly storage_uri: string | null;
}

export interface AdminActionProjectRow {
  readonly admin_user_id: string;
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
}

export interface AdminActionParserVersionRow {
  readonly id: string;
  readonly status: string;
}

export function parseAdminActionIdRow(value: unknown, context: string): AdminActionIdRow {
  const row = requireRecord(value, context);
  return { id: requireString(row.id, context, 'id') };
}

export function parseAdminActionProjectRow(value: unknown): AdminActionProjectRow {
  const row = requireRecord(value, 'admin project row');
  return {
    admin_user_id: requireString(row.admin_user_id, 'admin project row', 'admin_user_id'),
    description: requireNullableString(row.description, 'admin project row', 'description'),
    id: requireString(row.id, 'admin project row', 'id'),
    name: requireString(row.name, 'admin project row', 'name'),
    slug: requireString(row.slug, 'admin project row', 'slug'),
    visibility: requireProjectVisibility(row.visibility, 'admin project row', 'visibility'),
  };
}

export function parseAdminActionDataSourceRow(value: unknown): AdminActionDataSourceRow {
  const row = requireRecord(value, 'admin data source row');
  return {
    id: requireString(row.id, 'admin data source row', 'id'),
    source_type: requireSourceType(row.source_type, 'admin data source row', 'source_type'),
  };
}

export function parseAdminActionDataSourceIngestRow(
  value: unknown,
): AdminActionDataSourceIngestRow {
  const row = requireRecord(value, 'admin data source ingest row');
  return {
    id: requireString(row.id, 'admin data source ingest row', 'id'),
    source_type: requireSourceType(row.source_type, 'admin data source ingest row', 'source_type'),
    storage_uri: requireNullableString(
      row.storage_uri,
      'admin data source ingest row',
      'storage_uri',
    ),
  };
}

export function parseAdminActionAdminCountRow(value: unknown): number {
  const row = requireRecord(value, 'admin count row');
  const adminCount = row.admin_count;
  if (typeof adminCount === 'number') {
    return adminCount;
  }
  if (typeof adminCount === 'string' && /^\d+$/.test(adminCount)) {
    return Number(adminCount);
  }
  throw new Error('Invalid admin count row field: admin_count');
}

export function parseAdminActionParserVersionRow(value: unknown): AdminActionParserVersionRow {
  const row = requireRecord(value, 'parser version row');
  return {
    id: requireString(row.id, 'parser version row', 'id'),
    status: requireString(row.status, 'parser version row', 'status'),
  };
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Invalid ${context}.`);
}

function requireString(value: unknown, context: string, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function requireNullableString(value: unknown, context: string, fieldName: string): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function requireProjectVisibility(
  value: unknown,
  context: string,
  fieldName: string,
): ProjectVisibility {
  if (isProjectVisibility(value)) {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function requireSourceType(value: unknown, context: string, fieldName: string): SourceType {
  if (isSourceType(value)) {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}
