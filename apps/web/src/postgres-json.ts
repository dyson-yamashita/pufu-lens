import type postgres from 'postgres';

export function jsonParameter(sql: Pick<postgres.Sql, 'json'>, value: unknown) {
  return sql.json(value as Parameters<postgres.Sql['json']>[0]);
}
