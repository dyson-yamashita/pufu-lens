import type postgres from 'postgres';

export function jsonParameter(sql: Pick<postgres.Sql, 'json'>, value: unknown) {
  if (typeof value === 'string') {
    throw new TypeError('jsonParameter expects a raw JSON value, not a pre-serialized string.');
  }
  return sql.json(value as Parameters<postgres.Sql['json']>[0]);
}
