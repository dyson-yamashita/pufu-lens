/** Minimal D1 binding surface, kept inside the Cloudflare adapter/composition. */
export interface D1Binding {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  all(): Promise<D1Result>;
}
export interface D1Result {
  readonly success: boolean;
  readonly results: readonly unknown[];
}

/** Checks transport results before exposing unknown rows to capability parsers. */
export function rows(result: D1Result): readonly unknown[] {
  if (!result.success || !Array.isArray(result.results)) throw new Error('D1 unavailable');
  return result.results;
}

/** Validates a SQL row object before field access. */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid D1 row');
  return value as Record<string, unknown>;
}

/** Rejects missing identities before SQL binding and while parsing rows. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid graph string');
  return value;
}

/** Binds an ID set as one JSON parameter; bounds payload size without silently losing IDs. */
export function ids(values: readonly string[]): string {
  for (const value of values) text(value);
  const json = JSON.stringify([...new Set(values)]);
  if (new TextEncoder().encode(json).length > 100_000) throw new Error('Graph ID set too large');
  return json;
}
