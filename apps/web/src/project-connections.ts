import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NextRequest } from 'next/server';
import type postgres from 'postgres';
import type { ConnectionProvider, SourceType } from './admin-data';
import { getProjectMembership } from './admin-db';
import { getRequiredAdminSql } from './admin-sql';
import { getSessionUserId } from './auth-session';

const CONNECTION_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const ENCRYPTED_CONNECTION_SECRET_PREFIX = 'encrypted:';
const GOOGLE_BASE_SCOPES = ['openid', 'email', 'profile'] as const;
const GOOGLE_SOURCE_SCOPES: Partial<Record<SourceType, readonly string[]>> = {
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
};

type ConnectionState = {
  readonly projectSlug: string;
  readonly provider: ConnectionProvider;
  readonly sourceType?: SourceType;
  readonly timestamp: number;
};

type GoogleTokenResponse = {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
};

type GoogleUserInfo = {
  readonly email?: string;
  readonly sub?: string;
};

export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionConfigError';
  }
}

export async function googleConnectionStartUrl(input: {
  readonly projectSlug: string;
  readonly sourceType?: SourceType;
}): Promise<string> {
  await requireProjectAdmin(input.projectSlug);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new ConnectionConfigError('GOOGLE_CLIENT_ID is required.');
  }
  const scopes = googleScopes(input.sourceType);
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: clientId,
    include_granted_scopes: 'true',
    prompt: 'consent',
    redirect_uri: `${appBaseUrl()}/api/connections/google/callback`,
    response_type: 'code',
    scope: scopes.join(' '),
    state: signConnectionState({
      projectSlug: input.projectSlug,
      provider: 'google',
      sourceType: input.sourceType,
      timestamp: Date.now(),
    }),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function githubConnectionStartUrl(input: {
  readonly projectSlug: string;
}): Promise<string> {
  await requireProjectAdmin(input.projectSlug);
  const metadata = await readProjectProviderMetadata(input.projectSlug, 'github');
  const appSlug = typeof metadata.githubAppSlug === 'string' ? metadata.githubAppSlug : null;
  if (!appSlug) {
    throw new ConnectionConfigError(
      'GitHub App slug is required. Configure GitHub App in project Settings.',
    );
  }
  const params = new URLSearchParams({
    state: signConnectionState({
      projectSlug: input.projectSlug,
      provider: 'github',
      timestamp: Date.now(),
    }),
  });
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?${params.toString()}`;
}

export async function completeGoogleConnection(request: NextRequest): Promise<string> {
  const state = verifyConnectionState(readRequiredSearchParam(request, 'state'), 'google');
  const connectedByUserId = await requireProjectAdmin(state.projectSlug);
  const code = readRequiredSearchParam(request, 'code');
  const token = await exchangeGoogleCode(code);
  if (!token.access_token) {
    throw new Error('Google token exchange did not return an access token.');
  }
  const scopes = token.scope?.split(/\s+/).filter(Boolean) ?? googleScopes(state.sourceType);
  const userInfo = await fetchGoogleUserInfo(token.access_token);
  await upsertProjectConnection({
    accountEmail: userInfo.email ?? null,
    accountLogin: null,
    connectedByUserId,
    expiresAt:
      typeof token.expires_in === 'number'
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : null,
    metadata: {
      driveEnabled: scopes.includes('https://www.googleapis.com/auth/drive.readonly'),
      gmailEnabled: scopes.includes('https://www.googleapis.com/auth/gmail.readonly'),
      sourceType: state.sourceType ?? null,
    },
    projectSlug: state.projectSlug,
    provider: 'google',
    providerAccountId: userInfo.sub ?? userInfo.email ?? 'google-account',
    accessToken: token.access_token ?? null,
    refreshToken: token.refresh_token ?? null,
    scopes,
  });
  return settingsUrl(state.projectSlug, { connectionStatus: 'google-connected' });
}

export async function completeGithubConnection(request: NextRequest): Promise<string> {
  const state = verifyConnectionState(readRequiredSearchParam(request, 'state'), 'github');
  const connectedByUserId = await requireProjectAdmin(state.projectSlug);
  const installationId = readRequiredSearchParam(request, 'installation_id');
  const setupAction = request.nextUrl.searchParams.get('setup_action') ?? 'install';
  const existingMetadata = await readProjectProviderMetadata(state.projectSlug, 'github');
  await upsertProjectConnection({
    accountEmail: null,
    accountLogin: null,
    connectedByUserId,
    expiresAt: null,
    metadata: {
      ...existingMetadata,
      installationId,
      setupAction,
    },
    projectSlug: state.projectSlug,
    provider: 'github',
    providerAccountId: installationId,
    accessToken: null,
    refreshToken: null,
    scopes: ['github-app-installation'],
  });
  return settingsUrl(state.projectSlug, { connectionStatus: 'github-connected' });
}

export async function saveGithubAppConnectionConfig(input: {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKey: string;
  readonly projectSlug: string;
}): Promise<void> {
  const connectedByUserId = await requireProjectAdmin(input.projectSlug);
  const appSlug = input.appSlug.trim();
  const appId = input.appId.trim();
  const existingMetadata = await readProjectProviderMetadata(input.projectSlug, 'github');
  const privateKey = normalizePrivateKeyPem(input.privateKey);
  if (!appSlug) {
    throw new ConnectionConfigError('GitHub App slug is required.');
  }
  if (!/^[1-9]\d*$/.test(appId)) {
    throw new ConnectionConfigError('GitHub App ID must be a positive integer.');
  }
  const metadata: Record<string, unknown> = {
    githubAppId: appId,
    githubAppSlug: appSlug,
  };
  if (privateKey) {
    validatePrivateKey(privateKey);
    metadata.githubAppPrivateKeyEncrypted = encryptConnectionSecret(privateKey);
    metadata.githubPrivateKeyConfigured = true;
  } else if (isEncryptedConnectionSecret(existingMetadata.githubAppPrivateKeyEncrypted)) {
    metadata.githubPrivateKeyConfigured = true;
  } else {
    throw new ConnectionConfigError('GitHub App private key is required.');
  }
  const sql = getRequiredAdminSql();
  await sql`
    INSERT INTO public.oauth_connections (
      project_id,
      user_id,
      provider,
      provider_account_id,
      account_email,
      account_login,
      scopes,
      metadata,
      access_token_secret,
      refresh_token_secret,
      expires_at
    )
    SELECT
      projects.id,
      ${connectedByUserId},
      'github',
      '',
      null,
      null,
      ARRAY[]::text[],
      ${sql.json(metadata as postgres.JSONValue)},
      null,
      null,
      null
    FROM public.projects
    WHERE projects.slug = ${input.projectSlug}
    ON CONFLICT (project_id, provider)
    WHERE project_id IS NOT NULL
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      metadata = oauth_connections.metadata || EXCLUDED.metadata,
      updated_at = now()
  `;
}

export function connectionErrorSettingsUrl(projectSlug: string | null, error: unknown): string {
  const message =
    error instanceof ConnectionConfigError
      ? 'configuration'
      : error instanceof Error
        ? 'callback'
        : 'unknown';
  return settingsUrl(projectSlug ?? '', { connectionError: message });
}

export function settingsUrl(
  projectSlug: string,
  params: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return projectSlug ? `/projects/${projectSlug}/admin/settings${suffix}` : `/projects${suffix}`;
}

function googleScopes(sourceType: SourceType | undefined): readonly string[] {
  return [...GOOGLE_BASE_SCOPES, ...(sourceType ? (GOOGLE_SOURCE_SCOPES[sourceType] ?? []) : [])];
}

async function requireProjectAdmin(projectSlug: string): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) {
    throw new Error('Authentication is required.');
  }
  const membership = await getProjectMembership(projectSlug, userId);
  if (!membership.canManageMembers) {
    throw new Error(`Connection management denied for project slug: ${projectSlug}`);
  }
  return userId;
}

function signConnectionState(state: ConnectionState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  const signature = createHmac('sha256', connectionStateSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyConnectionState(value: string, provider: ConnectionProvider): ConnectionState {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) {
    throw new Error('Invalid connection state.');
  }
  const expected = createHmac('sha256', connectionStateSecret())
    .update(payload)
    .digest('base64url');
  if (!safeEqual(signature, expected)) {
    throw new Error('Invalid connection state signature.');
  }
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConnectionState;
  if (parsed.provider !== provider) {
    throw new Error('Connection state provider mismatch.');
  }
  if (Date.now() - parsed.timestamp > CONNECTION_STATE_MAX_AGE_MS) {
    throw new Error('Connection state expired.');
  }
  return parsed;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConnectionConfigError(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Google connection callback.',
    );
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${appBaseUrl()}/api/connections/google/callback`,
    }),
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed with status ${response.status}.`);
  }
  return (await response.json()) as GoogleTokenResponse;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Google user info with status ${response.status}.`);
  }
  return (await response.json()) as GoogleUserInfo;
}

async function upsertProjectConnection(input: {
  readonly accountEmail: string | null;
  readonly accountLogin: string | null;
  readonly connectedByUserId: string;
  readonly expiresAt: string | null;
  readonly metadata: Record<string, unknown>;
  readonly projectSlug: string;
  readonly provider: ConnectionProvider;
  readonly providerAccountId: string;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly scopes: readonly string[];
}): Promise<void> {
  const sql = getRequiredAdminSql();
  const accessTokenSecret = input.accessToken ? encodeConnectionSecret(input.accessToken) : null;
  const refreshTokenSecret = input.refreshToken ? encodeConnectionSecret(input.refreshToken) : null;
  await sql`
    INSERT INTO public.oauth_connections (
      project_id,
      user_id,
      provider,
      provider_account_id,
      account_email,
      account_login,
      scopes,
      metadata,
      access_token_secret,
      refresh_token_secret,
      expires_at
    )
    SELECT
      projects.id,
      ${input.connectedByUserId},
      ${input.provider},
      ${input.providerAccountId},
      ${input.accountEmail},
      ${input.accountLogin},
      ${input.scopes},
      ${sql.json(input.metadata as postgres.JSONValue)},
      ${accessTokenSecret},
      ${refreshTokenSecret},
      ${input.expiresAt}
    FROM public.projects
    WHERE projects.slug = ${input.projectSlug}
    ON CONFLICT (project_id, provider)
    WHERE project_id IS NOT NULL
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      provider_account_id = EXCLUDED.provider_account_id,
      account_email = EXCLUDED.account_email,
      account_login = EXCLUDED.account_login,
      scopes = EXCLUDED.scopes,
      metadata = EXCLUDED.metadata,
      access_token_secret = EXCLUDED.access_token_secret,
      refresh_token_secret = COALESCE(
        EXCLUDED.refresh_token_secret,
        oauth_connections.refresh_token_secret
      ),
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
  `;
}

export async function readProjectConnectionAccessToken(input: {
  readonly projectId: string;
  readonly provider: ConnectionProvider;
  readonly sql: postgres.Sql;
}): Promise<string | null> {
  const rows = (await input.sql`
    SELECT
      access_token_secret,
      refresh_token_secret,
      expires_at
    FROM public.oauth_connections
    WHERE project_id = ${input.projectId}
      AND provider = ${input.provider}
    LIMIT 1
  `) as Array<{
    access_token_secret: string | null;
    expires_at: Date | string | null;
    refresh_token_secret: string | null;
  }>;
  const connection = rows[0];
  const secretRef = connection?.access_token_secret;
  if (!connection || !secretRef) {
    return null;
  }
  if (!isExpired(connection.expires_at)) {
    return readConnectionSecret(secretRef);
  }
  const refreshToken = connection.refresh_token_secret
    ? await readConnectionSecret(connection.refresh_token_secret)
    : null;
  if (input.provider !== 'google' || !refreshToken) {
    return null;
  }
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  if (!refreshed.access_token) {
    return null;
  }
  const expiresAt =
    typeof refreshed.expires_in === 'number'
      ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
      : null;
  const refreshedAccessTokenSecret = encodeConnectionSecret(refreshed.access_token);
  await input.sql`
    UPDATE public.oauth_connections
    SET
      access_token_secret = ${refreshedAccessTokenSecret},
      expires_at = ${expiresAt},
      updated_at = now()
    WHERE project_id = ${input.projectId}
      AND provider = ${input.provider}
  `;
  return refreshed.access_token;
}

export async function createGitHubInstallationAccessToken(input: {
  readonly projectId: string;
  readonly sql: postgres.Sql;
}): Promise<string | null> {
  const rows = (await input.sql`
    SELECT metadata
    FROM public.oauth_connections
    WHERE project_id = ${input.projectId}
      AND provider = 'github'
    LIMIT 1
  `) as Array<{ metadata: unknown }>;
  const metadata = rows[0] && isRecord(rows[0].metadata) ? rows[0].metadata : {};
  const installationId = metadata.installationId;
  if (typeof installationId !== 'string' && typeof installationId !== 'number') {
    return null;
  }
  const appId = typeof metadata.githubAppId === 'string' ? metadata.githubAppId : null;
  const privateKey = githubAppPrivateKey(metadata);
  if (!appId || !privateKey) {
    throw new ConnectionConfigError(
      'GitHub App ID and private key are required for GitHub App collection. Configure them in Settings.',
    );
  }
  const appJwt = createGitHubAppJwt(appId, privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(
      String(installationId),
    )}/access_tokens`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt}`,
        'user-agent': 'pufu-lens-github-app/0.1',
        'x-github-api-version': '2022-11-28',
      },
      method: 'POST',
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token request failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { readonly token?: unknown };
  return typeof body.token === 'string' ? body.token : null;
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

function normalizePrivateKeyPem(value: string): string {
  return value.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\\n/g, '\n');
}

function validatePrivateKey(value: string): void {
  try {
    createPrivateKey(value);
  } catch {
    throw new ConnectionConfigError('GitHub App private key must be a valid PEM private key.');
  }
}

type EncryptedConnectionSecret = {
  readonly alg: 'aes-256-gcm';
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
};

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
    isRecord(value) &&
    value.alg === 'aes-256-gcm' &&
    typeof value.ciphertext === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string'
  );
}

function connectionSecretKey(): Buffer {
  const value = process.env.CONNECTION_SECRET_KEY ?? process.env.AUTH_SECRET;
  if (!value) {
    throw new ConnectionConfigError(
      'CONNECTION_SECRET_KEY is required to encrypt connection secrets.',
    );
  }
  return createHash('sha256').update(value).digest();
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConnectionConfigError(
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
    return {};
  }
  return (await response.json()) as GoogleTokenResponse;
}

function encodeConnectionSecret(value: string): string {
  return `${ENCRYPTED_CONNECTION_SECRET_PREFIX}${Buffer.from(
    JSON.stringify(encryptConnectionSecret(value)),
    'utf8',
  ).toString('base64url')}`;
}

async function readConnectionSecret(secretValue: string): Promise<string | null> {
  if (secretValue.startsWith(ENCRYPTED_CONNECTION_SECRET_PREFIX)) {
    const encoded = secretValue.slice(ENCRYPTED_CONNECTION_SECRET_PREFIX.length);
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isEncryptedConnectionSecret(parsed)) {
      throw new Error('Connection secret payload is invalid.');
    }
    return decryptConnectionSecret(parsed);
  }
  return readLegacyLocalConnectionSecret(secretValue);
}

function isExpired(value: Date | string | null): boolean {
  if (!value) {
    return false;
  }
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) ? false : expiresAt.getTime() <= Date.now() + 60_000;
}

async function readLegacyLocalConnectionSecret(secretRef: string): Promise<string | null> {
  try {
    return await readFile(localConnectionSecretPath(secretRef), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readProjectProviderMetadata(
  projectSlug: string,
  provider: ConnectionProvider,
): Promise<Record<string, unknown>> {
  const sql = getRequiredAdminSql();
  const rows = (await sql`
    SELECT oc.metadata
    FROM public.oauth_connections oc
    JOIN public.projects p ON p.id = oc.project_id
    WHERE p.slug = ${projectSlug}
      AND oc.provider = ${provider}
    LIMIT 1
  `) as Array<{ metadata: unknown }>;
  return rows[0] && isRecord(rows[0].metadata) ? rows[0].metadata : {};
}

function localConnectionSecretPath(secretRef: string): string {
  const filename = Buffer.from(secretRef, 'utf8').toString('base64url');
  return resolve(localConnectionSecretRoot(), `${filename}.secret`);
}

function localConnectionSecretRoot(): string {
  const storageRoot =
    process.env.STORAGE_ROOT ??
    process.env.LOCAL_STORAGE_ROOT ??
    resolve(process.cwd(), '../../.data/volumes/pufu-lens-data');
  return resolve(storageRoot, 'connection-secrets');
}

function readRequiredSearchParam(request: NextRequest, name: string): string {
  const value = request.nextUrl.searchParams.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function appBaseUrl(): string {
  const url = process.env.APP_BASE_URL ?? process.env.AUTH_URL ?? 'http://localhost:3000';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function connectionStateSecret(): string {
  return process.env.AUTH_SECRET ?? 'pufu-lens-local-development-secret';
}
