/**
 * Internal GitHub lifecycle contract shared by chat retrieval paths.
 *
 * Issue #648 should treat `statusKnown=false` as lifecycle not yet synchronized.
 */
export type GitHubDocumentLifecycle = {
  closedAt: string | null;
  draft: boolean | null;
  kind: 'issue' | 'pull_request';
  merged: boolean | null;
  mergedAt: string | null;
  state: 'closed' | 'open';
  stateReason: string | null;
  statusKnown: boolean;
  updatedAt: string;
};

/** Runtime-validates unknown lifecycle JSON from SQL metadata projections. */
export function parseGitHubDocumentLifecycle(value: unknown): GitHubDocumentLifecycle | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid GitHub lifecycle metadata.');
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const state = record.state;
  if (kind !== 'issue' && kind !== 'pull_request') {
    throw new Error('Invalid GitHub lifecycle kind.');
  }
  if (state !== 'open' && state !== 'closed') {
    throw new Error('Invalid GitHub lifecycle state.');
  }
  return {
    closedAt: readNullableIsoTimestamp(record.closedAt),
    draft: readNullableBoolean(record.draft),
    kind,
    merged: readNullableBoolean(record.merged),
    mergedAt: readNullableIsoTimestamp(record.mergedAt),
    state,
    stateReason: readNullableString(record.stateReason),
    statusKnown: record.statusKnown === true,
    updatedAt: requiredIsoTimestamp(record.updatedAt, 'updatedAt'),
  };
}

function readNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNullableIsoTimestamp(value: unknown): string | null {
  const normalized = readNullableString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error('Invalid GitHub lifecycle timestamp.');
  }
  return new Date(parsed).toISOString();
}

function requiredIsoTimestamp(value: unknown, fieldName: string): string {
  const normalized = readNullableIsoTimestamp(value);
  if (!normalized) {
    throw new Error(`GitHub lifecycle field ${fieldName} is required.`);
  }
  return normalized;
}
