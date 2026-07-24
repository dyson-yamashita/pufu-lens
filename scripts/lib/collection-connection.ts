import { createCipheriv, createDecipheriv, createHash, createSign, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { parseOAuthConnectionRow } from './collection-connection-row-parsers.ts';

const ENCRYPTED_CONNECTION_SECRET_PREFIX = 'encrypted:';

export type CollectionSourceType = 'drive' | 'github' | 'gmail' | 'web';
export type CollectionOAuthSourceType = Exclude<CollectionSourceType, 'web'>;
export type ConnectionProvider = 'github' | 'google';

export interface CollectionConnection {
  id: string;
  provider: ConnectionProvider;
  token: string;
  userId: string;
}

type GoogleTokenResponse = {
  readonly access_token?: string;
  readonly expires_in?: number;
};

type EncryptedConnectionSecret = {
  readonly alg: 'aes-256-gcm';
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
};

export function providerForSource(
  sourceType: CollectionSourceType,
): ConnectionProvider | undefined {
  if (sourceType === 'drive' || sourceType === 'gmail') {
    return 'google';
  }
  if (sourceType === 'github') {
    return 'github';
  }
  return undefined;
}

export function requiredCollectionToken(
  sourceType: CollectionOAuthSourceType,
  connection: CollectionConnection | undefined,
): string {
  if (!connection?.token) {
    throw new Error(
      `${sourceType} collection requires a configured OAuth connection for this project. Connect the source in Settings or pass --connection-id.`,
    );
  }
  return connection.token;
}

/**
 * Resolves the OAuth connection for a project-scoped data source.
 */
export async function readProjectCollectionConnection(input: {
  dataSourceId?: string;
  projectSlug: string;
  provider: ConnectionProvider;
  sourceType: CollectionOAuthSourceType;
  sql: postgres.Sql;
}): Promise<CollectionConnection | undefined> {
  const sourceScope = requiredScopeForSourceType(input.sourceType);
  const scopeFilter = sourceScope ? input.sql`${sourceScope} = ANY(oc.scopes)` : input.sql`true`;
  const githubFilter =
    input.provider === 'github' ? input.sql`AND oc.metadata ? 'installationId'` : input.sql``;
  const rows = await input.sql`
    SELECT
      oc.id::text AS id,
      oc.provider,
      oc.user_id::text AS "userId",
      oc.access_token_secret AS "accessTokenSecret",
      oc.refresh_token_secret AS "refreshTokenSecret",
      oc.expires_at AS "expiresAt",
      oc.metadata
    FROM public.oauth_connections oc
    JOIN public.projects p ON p.id = oc.project_id
    WHERE p.slug = ${input.projectSlug}
      AND oc.provider = ${input.provider}
      AND (
        ${input.dataSourceId ?? null}::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.data_sources ds
          WHERE ds.id = ${input.dataSourceId ?? null}::uuid
            AND ds.project_id = p.id
            AND ds.source_type = ${input.sourceType}
            AND ds.connection_id = oc.id
        )
      )
      AND (oc.expires_at IS NULL OR oc.expires_at > now())
      AND (oc.metadata->>'connectionError') IS DISTINCT FROM 'true'
      AND (oc.metadata->>'scopeMissing') IS DISTINCT FROM 'true'
      AND COALESCE(oc.metadata->>'status', 'connected') = 'connected'
      AND ${scopeFilter}
      ${githubFilter}
    LIMIT 1
  `;
  const connection = rows[0];
  if (!connection) {
    return undefined;
  }
  return toCollectionConnection({
    connection: parseOAuthConnectionRow(connection),
    sql: input.sql,
  });
}

/**
 * Resolves an explicit OAuth connection within project and data-source boundaries.
 */
export async function readCollectionConnection(input: {
  connectionId: string;
  dataSourceId?: string;
  projectSlug: string;
  provider: ConnectionProvider;
  sourceType: CollectionOAuthSourceType;
  sql: postgres.Sql;
}): Promise<CollectionConnection> {
  assertUuid(input.connectionId, '--connection-id');
  const sourceScope = requiredScopeForSourceType(input.sourceType);
  const scopeFilter = sourceScope ? input.sql`${sourceScope} = ANY(oc.scopes)` : input.sql`true`;
  const githubFilter =
    input.provider === 'github' ? input.sql`AND oc.metadata ? 'installationId'` : input.sql``;
  const rows = await input.sql`
    SELECT
      oc.id::text AS id,
      oc.provider,
      oc.user_id::text AS "userId",
      oc.access_token_secret AS "accessTokenSecret",
      oc.refresh_token_secret AS "refreshTokenSecret",
      oc.expires_at AS "expiresAt",
      oc.metadata
    FROM public.oauth_connections oc
    JOIN public.projects p ON p.id = oc.project_id
    WHERE oc.id = ${input.connectionId}
      AND p.slug = ${input.projectSlug}
      AND oc.provider = ${input.provider}
      AND (
        ${input.dataSourceId ?? null}::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.data_sources ds
          WHERE ds.id = ${input.dataSourceId ?? null}::uuid
            AND ds.project_id = p.id
            AND ds.source_type = ${input.sourceType}
            AND ds.connection_id = oc.id
        )
      )
      AND (oc.expires_at IS NULL OR oc.expires_at > now())
      AND (oc.metadata->>'connectionError') IS DISTINCT FROM 'true'
      AND (oc.metadata->>'scopeMissing') IS DISTINCT FROM 'true'
      AND COALESCE(oc.metadata->>'status', 'connected') = 'connected'
      AND ${scopeFilter}
      ${githubFilter}
    LIMIT 1
  `;
  const connection = rows[0];
  if (!connection) {
    throw new Error('OAuth connection was not found for the project and source type.');
  }
  return toCollectionConnection({
    connection: parseOAuthConnectionRow(connection),
    sql: input.sql,
  });
}

/**
 * Resolves a GitHub OAuth token for lifecycle reconciliation scoped to one data source.
 */
export async function readGitHubDataSourceConnection(input: {
  connectionId?: string;
  dataSourceId: string;
  projectSlug: string;
  sql: postgres.Sql;
}): Promise<CollectionConnection> {
  if (input.connectionId) {
    return readCollectionConnection({
      connectionId: input.connectionId,
      dataSourceId: input.dataSourceId,
      projectSlug: input.projectSlug,
      provider: 'github',
      sourceType: 'github',
      sql: input.sql,
    });
  }
  const connection = await readProjectCollectionConnection({
    dataSourceId: input.dataSourceId,
    projectSlug: input.projectSlug,
    provider: 'github',
    sourceType: 'github',
    sql: input.sql,
  });
  if (!connection) {
    throw new Error(
      'GitHub lifecycle reconciliation requires a configured OAuth connection for the data source.',
    );
  }
  return connection;
}

/**
 * Resolves and caches GitHub OAuth tokens per connection id for bounded lifecycle batches.
 */
export async function resolveGitHubLifecycleToken(input: {
  connectionId: string | null;
  dataSourceId: string;
  projectSlug: string;
  sql: postgres.Sql;
  tokenCache: Map<string, Promise<string>>;
}): Promise<string | undefined> {
  if (!input.connectionId) {
    return undefined;
  }
  const cached = input.tokenCache.get(input.connectionId);
  if (cached) {
    return cached;
  }
  const pending = readCollectionConnection({
    connectionId: input.connectionId,
    dataSourceId: input.dataSourceId,
    projectSlug: input.projectSlug,
    provider: 'github',
    sourceType: 'github',
    sql: input.sql,
  }).then((connection) => connection.token);
  input.tokenCache.set(input.connectionId, pending);
  return pending;
}

async function toCollectionConnection(input: {
  connection: ReturnType<typeof parseOAuthConnectionRow>;
  sql: postgres.Sql;
}): Promise<CollectionConnection> {
  return {
    id: input.connection.id,
    provider: input.connection.provider,
    token: await resolveConnectionToken({ connection: input.connection, sql: input.sql }),
    userId: input.connection.userId,
  };
}

function requiredScopeForSourceType(sourceType: CollectionOAuthSourceType): string | undefined {
  if (sourceType === 'gmail') {
    return 'https://www.googleapis.com/auth/gmail.readonly';
  }
  if (sourceType === 'drive') {
    return 'https://www.googleapis.com/auth/drive.readonly';
  }
  return undefined;
}

async function resolveConnectionToken(input: {
  connection: ReturnType<typeof parseOAuthConnectionRow>;
  sql: postgres.Sql;
}): Promise<string> {
  if (input.connection.provider === 'github') {
    if (input.connection.accessTokenSecret && !isExpired(input.connection.expiresAt)) {
      return decryptConnectionSecretValue(input.connection.accessTokenSecret);
    }
    return createGitHubInstallationAccessToken(input.connection.metadata);
  }

  if (input.connection.accessTokenSecret && !isExpired(input.connection.expiresAt)) {
    return decryptConnectionSecretValue(input.connection.accessTokenSecret);
  }
  if (!input.connection.refreshTokenSecret) {
    throw new Error('Google OAuth connection does not have a refresh token.');
  }

  const refreshToken = decryptConnectionSecretValue(input.connection.refreshTokenSecret);
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  if (!refreshed.access_token) {
    throw new Error('Google OAuth token refresh did not return an access token.');
  }
  const expiresAt =
    typeof refreshed.expires_in === 'number'
      ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
      : null;
  const accessTokenSecret = encryptConnectionSecretValue(refreshed.access_token);
  await input.sql`
    UPDATE public.oauth_connections
    SET
      access_token_secret = ${accessTokenSecret},
      expires_at = ${expiresAt},
      updated_at = now()
    WHERE id = ${input.connection.id}
  `;
  return refreshed.access_token;
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Google token refresh.',
    );
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed with status ${response.status}.`);
  }
  return (await response.json()) as GoogleTokenResponse;
}

async function createGitHubInstallationAccessToken(
  metadataValue: Record<string, unknown>,
): Promise<string> {
  const installationId = metadataValue.installationId;
  if (typeof installationId !== 'string' && typeof installationId !== 'number') {
    throw new Error('GitHub OAuth connection does not have an installation id.');
  }
  const appId = typeof metadataValue.githubAppId === 'string' ? metadataValue.githubAppId : null;
  const privateKey = githubAppPrivateKey(metadataValue);
  if (!appId || !privateKey) {
    throw new Error(
      'GitHub App ID and private key are required for GitHub collection. Configure GitHub App in project Settings or pass --connection-id for a configured GitHub connection.',
    );
  }
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(
      String(installationId),
    )}/access_tokens`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${createGitHubAppJwt(appId, privateKey)}`,
        'user-agent': 'pufu-lens-github-app/0.1',
        'x-github-api-version': '2022-11-28',
      },
      method: 'POST',
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token request failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') {
    throw new Error('GitHub installation token response did not include a token.');
  }
  return body.token;
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    exp: now + 9 * 60,
    iat: now - 60,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

function githubAppPrivateKey(metadata: Record<string, unknown>): string | null {
  const encrypted = metadata.githubAppPrivateKeyEncrypted;
  if (isEncryptedConnectionSecret(encrypted)) {
    return decryptConnectionSecret(encrypted);
  }
  return null;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function isExpired(value: Date | string | null): boolean {
  if (!value) {
    return false;
  }
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) ? false : expiresAt.getTime() <= Date.now() + 60_000;
}

function encryptConnectionSecretValue(value: string): string {
  return `${ENCRYPTED_CONNECTION_SECRET_PREFIX}${Buffer.from(
    JSON.stringify(encryptConnectionSecret(value)),
    'utf8',
  ).toString('base64url')}`;
}

function encryptConnectionSecret(value: string): EncryptedConnectionSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', connectionSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptConnectionSecretValue(secretValue: string): string {
  if (!secretValue.startsWith(ENCRYPTED_CONNECTION_SECRET_PREFIX)) {
    throw new Error('OAuth connection token must be encrypted before collection.');
  }
  const encoded = secretValue.slice(ENCRYPTED_CONNECTION_SECRET_PREFIX.length);
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  if (!isEncryptedConnectionSecret(parsed)) {
    throw new Error('OAuth connection secret payload is invalid.');
  }
  return decryptConnectionSecret(parsed);
}

function decryptConnectionSecret(value: EncryptedConnectionSecret): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    connectionSecretKey(),
    Buffer.from(value.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function isEncryptedConnectionSecret(value: unknown): value is EncryptedConnectionSecret {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as EncryptedConnectionSecret).alg === 'aes-256-gcm' &&
    typeof (value as EncryptedConnectionSecret).ciphertext === 'string' &&
    typeof (value as EncryptedConnectionSecret).iv === 'string' &&
    typeof (value as EncryptedConnectionSecret).tag === 'string'
  );
}

function connectionSecretKey(): Buffer {
  const value = process.env.CONNECTION_SECRET_KEY ?? process.env.AUTH_SECRET;
  if (!value) {
    throw new Error('CONNECTION_SECRET_KEY is required to decrypt OAuth connection tokens.');
  }
  return createHash('sha256').update(value).digest();
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a valid UUID.`);
  }
}
