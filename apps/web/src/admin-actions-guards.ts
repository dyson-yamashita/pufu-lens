import type { ActorStatus } from './admin-actors.ts';
import { isSourceType, type SourceType } from './admin-data.ts';

export interface AdminActionIdRow {
  readonly id: string;
}

export interface AdminActionDataSourceRow {
  readonly id: string;
  readonly source_type: SourceType;
}

export interface AdminActionConnectionOwnerRow {
  readonly id: string;
  readonly userId: string;
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

export interface AdminActionProjectRecordRow {
  readonly id: string;
  readonly slug: string;
}

export interface AdminActionDataSourceRecordRow {
  readonly config: Record<string, unknown>;
  readonly enabled: boolean;
  readonly id: string;
  readonly ingestWindow: Record<string, unknown>;
  readonly projectId: string;
  readonly sourceType: SourceType;
}

export interface AdminActionRawDocumentRecordRow {
  readonly id: string;
  readonly ingestStatus: 'fetched' | 'held' | 'parsed' | 'indexed' | 'failed';
  readonly sourceId: string;
  readonly sourceType: SourceType;
}

export interface AdminActionDocumentGraphNodeRow {
  readonly graphNodeId: string;
}

export interface AdminActionProjectGraphNameRow {
  readonly graphName: string | null;
}

export interface AdminActionActorRow {
  readonly displayName: string;
  readonly graphNodeId: string;
  readonly id: string;
  readonly status: ActorStatus;
}

export interface AdminActionStorageObjectUriRow {
  readonly parsedUri: string | null;
  readonly storageUri: string;
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

export function parseAdminActionConnectionOwnerRow(value: unknown): AdminActionConnectionOwnerRow {
  const row = requireRecord(value, 'admin connection owner row');
  return {
    id: requireString(row.id, 'admin connection owner row', 'id'),
    userId: requireString(row.userId, 'admin connection owner row', 'userId'),
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

export function parseAdminActionProjectRecordRow(value: unknown): AdminActionProjectRecordRow {
  const row = requireRecord(value, 'collection project row');
  return {
    id: requireString(row.id, 'collection project row', 'id'),
    slug: requireString(row.slug, 'collection project row', 'slug'),
  };
}

export function parseAdminActionDataSourceRecordRow(
  value: unknown,
): AdminActionDataSourceRecordRow {
  const row = requireRecord(value, 'collection data source row');
  return {
    config: requireRecord(row.config, 'collection data source row field: config'),
    enabled: requireBoolean(row.enabled, 'collection data source row', 'enabled'),
    id: requireString(row.id, 'collection data source row', 'id'),
    ingestWindow:
      row.ingestWindow == null
        ? {}
        : requireRecord(row.ingestWindow, 'collection data source row field: ingestWindow'),
    projectId: requireString(row.projectId, 'collection data source row', 'projectId'),
    sourceType: requireSourceType(row.sourceType, 'collection data source row', 'sourceType'),
  };
}

export function parseAdminActionDocumentGraphNodeRow(
  value: unknown,
): AdminActionDocumentGraphNodeRow {
  const row = requireRecord(value, 'document graph node row');
  return {
    graphNodeId: requireString(row.graphNodeId, 'document graph node row', 'graphNodeId'),
  };
}

export function parseAdminActionProjectGraphNameRow(
  value: unknown,
): AdminActionProjectGraphNameRow {
  const row = requireRecord(value, 'project graph name row');
  return {
    graphName: requireNullableString(row.graphName, 'project graph name row', 'graphName'),
  };
}

export function parseAdminActionActorRow(value: unknown): AdminActionActorRow {
  const row = requireRecord(value, 'admin actor row');
  return {
    displayName: requireString(row.displayName, 'admin actor row', 'displayName'),
    graphNodeId: requireString(row.graphNodeId, 'admin actor row', 'graphNodeId'),
    id: requireString(row.id, 'admin actor row', 'id'),
    status: requireActorStatus(row.status, 'admin actor row', 'status'),
  };
}

export function parseAdminActionStorageObjectUriRow(
  value: unknown,
): AdminActionStorageObjectUriRow {
  const row = requireRecord(value, 'storage object uri row');
  return {
    parsedUri: requireNullableString(row.parsedUri, 'storage object uri row', 'parsedUri'),
    storageUri: requireString(row.storageUri, 'storage object uri row', 'storageUri'),
  };
}

export function parseAdminActionRawDocumentRecordRow(
  value: unknown,
): AdminActionRawDocumentRecordRow {
  const row = requireRecord(value, 'collection raw document row');
  return {
    id: requireString(row.id, 'collection raw document row', 'id'),
    ingestStatus: requireRawIngestStatus(
      row.ingestStatus,
      'collection raw document row',
      'ingestStatus',
    ),
    sourceId: requireString(row.sourceId, 'collection raw document row', 'sourceId'),
    sourceType: requireSourceType(row.sourceType, 'collection raw document row', 'sourceType'),
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

function requireBoolean(value: unknown, context: string, fieldName: string): boolean {
  if (typeof value === 'boolean') {
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

function requireRawIngestStatus(
  value: unknown,
  context: string,
  fieldName: string,
): AdminActionRawDocumentRecordRow['ingestStatus'] {
  if (
    value === 'fetched' ||
    value === 'held' ||
    value === 'parsed' ||
    value === 'indexed' ||
    value === 'failed'
  ) {
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

function requireActorStatus(value: unknown, context: string, fieldName: string): ActorStatus {
  if (value === 'active' || value === 'merged' || value === 'disabled') {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}
