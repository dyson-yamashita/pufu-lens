import type { ReprocessCandidate } from './ingest-workflow-reprocess.ts';

export type StaleParserCountRow = {
  count: number;
};

export type ReprocessResetSummaryRow = {
  queueItems: number;
  rawDocuments: number;
  selected: ReprocessCandidate[];
};

/**
 * Parses a stale parser raw document count SQL row.
 */
export function parseStaleParserCountRow(value: unknown): StaleParserCountRow {
  const row = requireRecord(value, 'stale parser count row');
  return {
    count: requireNonNegativeInteger(row.count, 'stale parser count row', 'count'),
  };
}

/**
 * Parses a reprocess candidate SQL row.
 */
export function parseReprocessCandidateRow(value: unknown): ReprocessCandidate {
  const row = requireRecord(value, 'reprocess candidate row');
  return {
    queueId: requireNonEmptyString(row.queueId, 'reprocess candidate row', 'queueId'),
    rawDocumentId: requireNonEmptyString(
      row.rawDocumentId,
      'reprocess candidate row',
      'rawDocumentId',
    ),
    sourceId: requireNonEmptyString(row.sourceId, 'reprocess candidate row', 'sourceId'),
  };
}

/**
 * Parses reprocess candidate SQL rows.
 */
export function parseReprocessCandidateRows(values: unknown): ReprocessCandidate[] {
  return parseSqlRows(values).map((value) => parseReprocessCandidateRow(value));
}

/**
 * Parses the reset summary SQL row, including the json_agg selected payload.
 */
export function parseReprocessResetSummaryRow(value: unknown): ReprocessResetSummaryRow {
  const row = requireRecord(value, 'reprocess reset summary row');
  return {
    queueItems: requireNonNegativeInteger(
      row.queueItems,
      'reprocess reset summary row',
      'queueItems',
    ),
    rawDocuments: requireNonNegativeInteger(
      row.rawDocuments,
      'reprocess reset summary row',
      'rawDocuments',
    ),
    selected: parseReprocessCandidateRows(
      parseJsonAggregate(row.selected, 'reprocess reset selected'),
    ),
  };
}

function parseJsonAggregate(value: unknown, context: string): unknown[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid ${context}: expected JSON array.`);
    }
    return parsed;
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error(`Invalid ${context}: expected JSON array.`);
}

function parseSqlRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid SQL row set.');
  }
  return value;
}

/**
 * Returns the first row from a SQL result set or throws when empty.
 */
export function parseFirstSqlRow(value: unknown, context: string): unknown {
  const rows = parseSqlRows(value);
  const firstRow = rows[0];
  if (firstRow === undefined) {
    throw new Error(`Missing ${context} row.`);
  }
  return firstRow;
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

function requireNonNegativeInteger(value: unknown, context: string, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}
