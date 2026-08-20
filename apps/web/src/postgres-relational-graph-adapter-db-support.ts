import assert from 'node:assert/strict';

export function singleRow(rows: readonly unknown[]): Record<string, unknown> {
  assert.equal(rows.length, 1);
  return requireRecord(rows[0], 'SQL row');
}

export function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Expected ${key} to be numeric.`);
}

export function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Expected ${key} to be a string.`);
}

export function timestampField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Expected ${key} to be a timestamp.`);
}

export function nullableStringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Expected ${key} to be a string or null.`);
}

export function requireJsonObjectField(
  row: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return requireRecord(row[key], key);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record.`);
  }
  return value as Record<string, unknown>;
}
