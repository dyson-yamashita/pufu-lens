import { isSourceType, type SourceType } from './admin-data.ts';

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

export interface AdminActionParserVersionRow {
  readonly id: string;
  readonly status: string;
}

export interface AdminActionSameHashCandidateRow {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceType: SourceType;
}

export function parseAdminActionIdRow(value: unknown, context: string): AdminActionIdRow {
  const row = requireRecord(value, context);
  return { id: requireString(row.id, context, 'id') };
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
  if (typeof adminCount === 'bigint') {
    return Number(adminCount);
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

export function parseAdminActionSameHashCandidateRow(
  value: unknown,
): AdminActionSameHashCandidateRow {
  const row = requireRecord(value, 'same hash candidate row');
  return {
    id: requireString(row.id, 'same hash candidate row', 'id'),
    sourceId: requireString(row.sourceId, 'same hash candidate row', 'sourceId'),
    sourceType: requireSourceType(row.sourceType, 'same hash candidate row', 'sourceType'),
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
  if (value === null || value === undefined || typeof value === 'string') {
    return value ?? null;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function requireSourceType(value: unknown, context: string, fieldName: string): SourceType {
  if (isSourceType(value)) {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}
