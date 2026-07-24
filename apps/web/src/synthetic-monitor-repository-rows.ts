import {
  SYNTHETIC_MONITOR_PERIOD_RUN_STATUSES,
  SYNTHETIC_MONITOR_REPORT_SCHEDULE_FREQUENCIES,
} from './synthetic-monitor-contract.ts';
import type {
  SyntheticMonitorDocumentRecord,
  SyntheticMonitorPeriodRunRecord,
  SyntheticMonitorProjectRecord,
  SyntheticMonitorRawDocumentRecord,
  SyntheticMonitorReportMetadataRecord,
  SyntheticMonitorReportScheduleRecord,
  SyntheticMonitorScheduleRecord,
} from './synthetic-monitor-service.ts';

/**
 * Parses a project lookup row returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed project record or null when no row exists.
 */
export function parseSyntheticMonitorProjectRow(
  rows: readonly unknown[],
): SyntheticMonitorProjectRecord | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error('Invalid project row: expected at most 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid project row: row is not an object.');
  }
  return {
    id: parseUuid(row.id, 'project.id'),
    slug: parseProjectSlug(row.slug, 'project.slug'),
    graphName: parseGraphName(row.graphName, 'project.graphName'),
  };
}

/**
 * Parses a raw document lookup row returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed raw document record or null when no row exists.
 */
export function parseSyntheticMonitorRawDocumentRow(
  rows: readonly unknown[],
): SyntheticMonitorRawDocumentRecord | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error('Invalid raw document row: expected at most 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid raw document row: row is not an object.');
  }
  return {
    id: parseUuid(row.id, 'raw_document.id'),
    ingestStatus: parseNonEmptyString(row.ingestStatus, 'raw_document.ingestStatus'),
    sourceVersion: parseNonEmptyString(row.sourceVersion, 'raw_document.sourceVersion'),
  };
}

/**
 * Parses a document lookup row returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed document record or null when no row exists.
 */
export function parseSyntheticMonitorDocumentRow(
  rows: readonly unknown[],
): SyntheticMonitorDocumentRecord | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error('Invalid document row: expected at most 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid document row: row is not an object.');
  }
  return {
    id: parseUuid(row.id, 'document.id'),
    rawDocumentId: parseUuid(row.rawDocumentId, 'document.rawDocumentId'),
    graphNodeId: parseNullableNonEmptyString(row.graphNodeId, 'document.graphNodeId'),
  };
}

/**
 * Parses chunk count rows returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Total and embedding-complete chunk counts.
 */
export function parseSyntheticMonitorChunkCountRow(rows: readonly unknown[]): {
  readonly total: number;
  readonly withEmbedding: number;
} {
  if (rows.length !== 1) {
    throw new Error('Invalid chunk count row: expected exactly 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid chunk count row: row is not an object.');
  }
  const total = parseNonNegativeInteger(row.total, 'chunk_count.total');
  const withEmbedding = parseNonNegativeInteger(row.withEmbedding, 'chunk_count.withEmbedding');
  if (withEmbedding > total) {
    throw new Error('Invalid chunk count row: withEmbedding exceeds total.');
  }
  return { total, withEmbedding };
}

/**
 * Parses schedule rows returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed schedule records.
 */
export function parseSyntheticMonitorScheduleRows(
  rows: readonly unknown[],
): readonly SyntheticMonitorScheduleRecord[] {
  return rows.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error(`Invalid schedule row[${index}]: row is not an object.`);
    }
    return {
      enabled: parseBoolean(row.enabled, `schedule[${index}].enabled`),
      retryCount: parseNonNegativeInteger(row.retryCount, `schedule[${index}].retryCount`),
      leaseExpiresAt: parseNullableIsoTimestamp(
        row.leaseExpiresAt,
        `schedule[${index}].leaseExpiresAt`,
      ),
      nextRunAt: parseNullableIsoTimestamp(row.nextRunAt, `schedule[${index}].nextRunAt`),
    };
  });
}

/**
 * Parses a report schedule row returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed report schedule record or null when no row exists.
 */
export function parseSyntheticMonitorReportScheduleRow(
  rows: readonly unknown[],
): SyntheticMonitorReportScheduleRecord | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error('Invalid report schedule row: expected at most 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid report schedule row: row is not an object.');
  }
  return {
    frequency: parseReportScheduleFrequency(row.frequency, 'report_schedule.frequency'),
    nextRunAt: parseNullableIsoTimestamp(row.nextRunAt, 'report_schedule.nextRunAt'),
  };
}

/**
 * Parses a period run row returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed period run record or null when no row exists.
 */
export function parseSyntheticMonitorPeriodRunRow(
  rows: readonly unknown[],
): SyntheticMonitorPeriodRunRecord | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error('Invalid period run row: expected at most 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid period run row: row is not an object.');
  }
  return {
    status: parsePeriodRunStatus(row.status, 'period_run.status'),
    reportId: parseNullableUuid(row.reportId, 'period_run.reportId'),
  };
}

/**
 * Parses report metadata rows returned by Synthetic Monitor repository queries.
 *
 * @param rows - Raw postgres rows.
 * @returns Parsed report metadata record or null when no row exists.
 */
export function parseSyntheticMonitorReportMetadataRow(
  rows: readonly unknown[],
): SyntheticMonitorReportMetadataRecord | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new Error('Invalid report metadata row: expected at most 1 row.');
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error('Invalid report metadata row: row is not an object.');
  }
  return {
    schemaVersion: parseNonEmptyString(row.schemaVersion, 'report.schemaVersion'),
    storageUri: parseNonEmptyString(row.storageUri, 'report.storageUri'),
  };
}

function parseReportScheduleFrequency(value: unknown, label: string): string {
  const text = parseNonEmptyString(value, label);
  if (
    !SYNTHETIC_MONITOR_REPORT_SCHEDULE_FREQUENCIES.includes(
      text as (typeof SYNTHETIC_MONITOR_REPORT_SCHEDULE_FREQUENCIES)[number],
    )
  ) {
    throw new Error(`Invalid ${label}: expected report schedule frequency.`);
  }
  return text;
}

function parsePeriodRunStatus(value: unknown, label: string): string {
  const text = parseNonEmptyString(value, label);
  if (
    !SYNTHETIC_MONITOR_PERIOD_RUN_STATUSES.includes(
      text as (typeof SYNTHETIC_MONITOR_PERIOD_RUN_STATUSES)[number],
    )
  ) {
    throw new Error(`Invalid ${label}: expected period run status.`);
  }
  return text;
}

function parseUuid(value: unknown, label: string): string {
  const text = parseNonEmptyString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`Invalid ${label}: expected UUID string.`);
  }
  return text.toLowerCase();
}

function parseNullableUuid(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return parseUuid(value, label);
}

function parseProjectSlug(value: unknown, label: string): string {
  const text = parseNonEmptyString(value, label);
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(text)) {
    throw new Error(`Invalid ${label}: expected lowercase slug.`);
  }
  return text;
}

function parseGraphName(value: unknown, label: string): string {
  const text = parseNonEmptyString(value, label);
  if (!/^[a-z][a-z0-9_]*$/.test(text)) {
    throw new Error(`Invalid ${label}: expected graph name.`);
  }
  return text;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}: expected non-empty string.`);
  }
  return value.trim();
}

function parseNullableNonEmptyString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return parseNonEmptyString(value, label);
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`Invalid ${label}: expected boolean.`);
}

function parseNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`Invalid ${label}: expected safe non-negative integer.`);
}

function parseNullableIsoTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const text = parseNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`Invalid ${label}: expected ISO timestamp string.`);
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
