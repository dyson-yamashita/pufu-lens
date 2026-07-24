export type OAuthConnectionRow = {
  accessTokenSecret: string | null;
  expiresAt: Date | string | null;
  id: string;
  metadata: Record<string, unknown>;
  provider: 'github' | 'google';
  refreshTokenSecret: string | null;
  userId: string;
};

/**
 * Runtime-validates an OAuth connection SQL row used by collection scripts.
 */
export function parseOAuthConnectionRow(value: unknown): OAuthConnectionRow {
  const row = requireRecord(value, 'oauth connection row');
  const provider = row.provider;
  if (provider !== 'github' && provider !== 'google') {
    throw new Error('Invalid oauth connection provider.');
  }
  return {
    accessTokenSecret: parseOptionalNullableString(row.accessTokenSecret, 'accessTokenSecret'),
    expiresAt: parseOptionalExpiresAt(row.expiresAt),
    id: requireString(row.id, 'id'),
    metadata: parseMetadata(row.metadata),
    provider,
    refreshTokenSecret: parseOptionalNullableString(row.refreshTokenSecret, 'refreshTokenSecret'),
    userId: requireString(row.userId, 'userId'),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Invalid oauth connection metadata.');
}

function parseOptionalExpiresAt(value: unknown): Date | string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date || typeof value === 'string') {
    return value;
  }
  throw new Error('Invalid oauth connection expiresAt.');
}

function parseOptionalNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid oauth connection field: ${fieldName}`);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Invalid ${context}.`);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid oauth connection field: ${fieldName}`);
  }
  return value;
}
