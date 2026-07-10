import type { DataSourceRecord, RawDocumentRecord } from './collection-pipeline.js';
import type { SourceType } from './ingestion-fixtures.js';

const COLLECTION_SOURCE_TYPES = ['drive', 'github', 'gmail', 'web'] as const;
const RAW_INGEST_STATUSES = ['fetched', 'held', 'parsed', 'indexed', 'failed'] as const;

/**
 * Parses a collection data source SQL row into a typed repository record.
 */
export function parseCollectionDataSourceRecordRow(value: unknown): DataSourceRecord {
  const row = requireRecord(value, 'collection data source row');

  return {
    config: requireRecord(row.config, 'collection data source row field: config'),
    enabled: requireBoolean(row.enabled, 'collection data source row', 'enabled'),
    id: requireNonEmptyString(row.id, 'collection data source row', 'id'),
    ingestWindow:
      row.ingestWindow == null
        ? {}
        : requireRecord(row.ingestWindow, 'collection data source row field: ingestWindow'),
    lastSyncSucceededAt: requireNullableIsoTimestamp(
      row.lastSyncSucceededAt,
      'collection data source row',
      'lastSyncSucceededAt',
    ),
    projectId: requireNonEmptyString(row.projectId, 'collection data source row', 'projectId'),
    sourceType: requireCollectionSourceType(
      row.sourceType,
      'collection data source row',
      'sourceType',
    ),
    syncCursor: requireRecord(row.syncCursor, 'collection data source row field: syncCursor'),
  };
}

/**
 * Parses collection data source SQL rows.
 */
export function parseCollectionDataSourceRecordRows(
  values: readonly unknown[],
): DataSourceRecord[] {
  return values.map((value) => parseCollectionDataSourceRecordRow(value));
}

/**
 * Parses a collection raw document SQL row into a typed repository record.
 */
export function parseCollectionRawDocumentRecordRow(value: unknown): RawDocumentRecord {
  const row = requireRecord(value, 'collection raw document row');
  return {
    id: requireNonEmptyString(row.id, 'collection raw document row', 'id'),
    ingestStatus: requireRawIngestStatus(
      row.ingestStatus,
      'collection raw document row',
      'ingestStatus',
    ),
    logicalSourceId: requireNonEmptyString(
      row.logicalSourceId,
      'collection raw document row',
      'logicalSourceId',
    ),
    sourceId: requireNonEmptyString(row.sourceId, 'collection raw document row', 'sourceId'),
    sourceType: requireCollectionSourceType(
      row.sourceType,
      'collection raw document row',
      'sourceType',
    ),
    sourceVersion: requireNonEmptyString(
      row.sourceVersion,
      'collection raw document row',
      'sourceVersion',
    ),
  };
}

/**
 * Parses the first collection raw document SQL row when present.
 */
export function parseOptionalCollectionRawDocumentRecordRow(
  values: readonly unknown[],
): RawDocumentRecord | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return parseCollectionRawDocumentRecordRow(values[0]);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Invalid ${context}.`);
}

function requireNonEmptyString(value: unknown, context: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${context} field: ${fieldName}`);
  }
  return value;
}

function requireBoolean(value: unknown, context: string, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function requireCollectionSourceType(
  value: unknown,
  context: string,
  fieldName: string,
): SourceType {
  if (value === 'drive' || value === 'github' || value === 'gmail' || value === 'web') {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function requireRawIngestStatus(
  value: unknown,
  context: string,
  fieldName: string,
): RawDocumentRecord['ingestStatus'] {
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

function requireNullableIsoTimestamp(
  value: unknown,
  context: string,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    if (Number.isNaN(Date.parse(value))) {
      throw new Error(`Invalid ${context} field: ${fieldName}`);
    }
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

export { COLLECTION_SOURCE_TYPES, RAW_INGEST_STATUSES };
