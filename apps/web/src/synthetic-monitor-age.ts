/**
 * Strict AGE count row parsing for Synthetic Monitor graph observations.
 */

/**
 * Parses a single-row AGE `AS (value agtype)` count result.
 *
 * @param rows - Raw postgres rows returned from a cypher count query.
 * @param label - Human-readable label used in parser errors.
 * @returns A safe non-negative integer count.
 */
export function parseSyntheticMonitorAgeCountRows(rows: readonly unknown[], label: string): number {
  if (rows.length !== 1) {
    throw new Error(`Invalid AGE ${label}: expected 1 row, received ${rows.length}.`);
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error(`Invalid AGE ${label}: row is not an object.`);
  }
  return parseAgeInteger(row.value, label);
}

function parseAgeInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  throw new Error(`Invalid AGE ${label}: value is not a safe non-negative integer.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
