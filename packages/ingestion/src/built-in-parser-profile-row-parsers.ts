import { BUILT_IN_SOURCE_TYPES } from './built-in-parser-profiles.js';
import type { SourceType } from './ingestion-fixtures.js';

export type BuiltInParserProfileTargetRow = {
  dataSourceId: string;
  projectId: string;
  sourceType: SourceType;
};

export type BuiltInParserProfileIdRow = {
  id: string;
};

/**
 * Parses a built-in parser profile target SQL row.
 */
export function parseBuiltInParserProfileTargetRow(value: unknown): BuiltInParserProfileTargetRow {
  const row = requireRecord(value, 'built-in parser profile target row');
  return {
    dataSourceId: requireNonEmptyString(
      row.dataSourceId,
      'built-in parser profile target row',
      'dataSourceId',
    ),
    projectId: requireNonEmptyString(
      row.projectId,
      'built-in parser profile target row',
      'projectId',
    ),
    sourceType: requireBuiltInSourceType(
      row.sourceType,
      'built-in parser profile target row',
      'sourceType',
    ),
  };
}

/**
 * Parses built-in parser profile target SQL rows.
 */
export function parseBuiltInParserProfileTargetRows(
  values: unknown,
): BuiltInParserProfileTargetRow[] {
  return parseSqlRows(values).map((value) => parseBuiltInParserProfileTargetRow(value));
}

/**
 * Parses a built-in parser profile id SQL row.
 */
export function parseBuiltInParserProfileIdRow(value: unknown): BuiltInParserProfileIdRow {
  const row = requireRecord(value, 'built-in parser profile id row');
  return {
    id: requireNonEmptyString(row.id, 'built-in parser profile id row', 'id'),
  };
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

function parseSqlRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid SQL row set.');
  }
  return value;
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

function requireBuiltInSourceType(value: unknown, context: string, fieldName: string): SourceType {
  if (typeof value === 'string' && isBuiltInSourceType(value)) {
    return value;
  }
  throw new Error(`Invalid ${context} field: ${fieldName}`);
}

function isBuiltInSourceType(value: string): value is SourceType {
  return (BUILT_IN_SOURCE_TYPES as readonly string[]).includes(value);
}
