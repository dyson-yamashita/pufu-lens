import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import {
  readCollectionConnection,
  readProjectCollectionConnection,
} from './collection-connection.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const ENCRYPTED_PREFIX = 'encrypted:';
const TEST_SECRET_KEY = 'issue-731-collection-connection-test-secret';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLIENT_ID = 'issue-731-google-client-id';
const GOOGLE_CLIENT_SECRET = 'issue-731-google-client-secret';

type EncryptedSecret = {
  readonly alg: 'aes-256-gcm';
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
};

type LookupKind = 'project' | 'explicit';

type LookupOverrides = {
  connectionId: string;
  dataSourceId: string;
  projectSlug: string;
  provider: 'google' | 'github';
  sourceType: 'drive' | 'gmail' | 'github';
};

const fixture = {
  driveConnectionId: '10000000-0000-0000-0000-000000000731',
  driveDataSourceId: '10000000-0000-0000-0000-000000000732',
  driveProjectId: '10000000-0000-0000-0000-000000000733',
  driveProjectSlug: 'issue-731-drive-refresh',
  githubConnectionId: '10000000-0000-0000-0000-000000000734',
  githubDataSourceId: '10000000-0000-0000-0000-000000000735',
  githubProjectId: '10000000-0000-0000-0000-000000000736',
  githubProjectSlug: 'issue-731-github-expired',
  gmailConnectionId: '10000000-0000-0000-0000-000000000737',
  gmailDataSourceId: '10000000-0000-0000-0000-000000000738',
  gmailProjectId: '10000000-0000-0000-0000-000000000739',
  gmailProjectSlug: 'issue-731-gmail-refresh',
  otherConnectionId: '10000000-0000-0000-0000-00000000073a',
  otherDataSourceId: '10000000-0000-0000-0000-00000000073b',
  otherProjectId: '10000000-0000-0000-0000-00000000073c',
  otherProjectSlug: 'issue-731-other-project',
  userId: '10000000-0000-0000-0000-00000000073d',
} as const;

type GoogleConnectionSeed = {
  accessToken: string;
  connectionId: string;
  dataSourceId: string;
  expiresAt: Date | null;
  metadata?: Record<string, unknown>;
  projectId: string;
  projectSlug: string;
  refreshToken?: string | null;
  scopes: string[];
  sourceType: 'drive' | 'gmail';
};

const driveSeed = (): GoogleConnectionSeed => ({
  accessToken: 'expired-drive-access-token',
  connectionId: fixture.driveConnectionId,
  dataSourceId: fixture.driveDataSourceId,
  expiresAt: pastDate(),
  projectId: fixture.driveProjectId,
  projectSlug: fixture.driveProjectSlug,
  refreshToken: 'drive-refresh-token',
  scopes: [DRIVE_SCOPE],
  sourceType: 'drive',
});

for (const lookupKind of ['project', 'explicit'] as const) {
  test(`expired Google connection with refresh token refreshes and persists for ${lookupKind} lookup`, {
    skip: !databaseUrl,
  }, async () => {
    await withGoogleFixture(driveSeed(), async ({ fetchCalls, sql }) => {
      const refreshedToken = `refreshed-drive-access-token-${lookupKind}`;
      installGoogleRefreshMock(fetchCalls, {
        accessToken: refreshedToken,
        refreshToken: 'drive-refresh-token',
      });

      const connection = await readGoogleConnection(lookupKind, sql);
      assert.equal(readToken(connection), refreshedToken);
      assert.equal(fetchCalls.length, 1);
      await assertStoredGoogleToken(sql, fixture.driveConnectionId, refreshedToken);

      const reused = await readGoogleConnection(lookupKind, sql);
      assert.equal(readToken(reused), refreshedToken);
      assert.equal(fetchCalls.length, 1);
    });
  });
}

test('future Google access token is reused without refresh', { skip: !databaseUrl }, async () => {
  await withGoogleFixture(
    {
      ...driveSeed(),
      accessToken: 'valid-drive-access-token',
      expiresAt: futureDate(),
    },
    async ({ fetchCalls, sql }) => {
      const connection = await readProjectCollectionConnection({
        dataSourceId: fixture.driveDataSourceId,
        projectSlug: fixture.driveProjectSlug,
        provider: 'google',
        sourceType: 'drive',
        sql,
      });
      assert.equal(connection?.token, 'valid-drive-access-token');
      assert.equal(fetchCalls.length, 0);
    },
  );
});

test('expired Gmail Google connection refreshes through the shared Google path', {
  skip: !databaseUrl,
}, async () => {
  await withGoogleFixture(
    {
      accessToken: 'expired-gmail-access-token',
      connectionId: fixture.gmailConnectionId,
      dataSourceId: fixture.gmailDataSourceId,
      expiresAt: pastDate(),
      projectId: fixture.gmailProjectId,
      projectSlug: fixture.gmailProjectSlug,
      refreshToken: 'gmail-refresh-token',
      scopes: [GMAIL_SCOPE],
      sourceType: 'gmail',
    },
    async ({ fetchCalls, sql }) => {
      const refreshedToken = 'refreshed-gmail-access-token';
      installGoogleRefreshMock(fetchCalls, {
        accessToken: refreshedToken,
        refreshToken: 'gmail-refresh-token',
      });

      const connection = await readProjectCollectionConnection({
        dataSourceId: fixture.gmailDataSourceId,
        projectSlug: fixture.gmailProjectSlug,
        provider: 'google',
        sourceType: 'gmail',
        sql,
      });

      assert.equal(connection?.token, refreshedToken);
      assert.equal(fetchCalls.length, 1);
      await assertStoredGoogleToken(sql, fixture.gmailConnectionId, refreshedToken);
    },
  );
});

for (const refreshToken of [null, '', undefined] as const) {
  const label = refreshToken === null ? 'null' : refreshToken === '' ? 'empty' : 'missing';
  for (const lookupKind of ['project', 'explicit'] as const) {
    test(`expired Google connection with ${label} refresh token is rejected without fetch (${lookupKind})`, {
      skip: !databaseUrl,
    }, async () => {
      await withGoogleFixture(
        {
          ...driveSeed(),
          refreshToken,
        },
        async ({ fetchCalls, sql }) => {
          await assertLookupRejected(lookupKind, sql);
          assert.equal(fetchCalls.length, 0);
        },
      );
    });
  }
}

const rejectionCases: Array<{
  label: string;
  lookups: 'both' | 'explicit-only';
  mutate: (seed: GoogleConnectionSeed) => GoogleConnectionSeed;
  overrides: (seed: GoogleConnectionSeed) => LookupOverrides;
}> = [
  {
    label: 'wrong project slug',
    lookups: 'both',
    mutate: (seed) => seed,
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.otherProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'wrong explicit connection id',
    lookups: 'explicit-only',
    mutate: (seed) => seed,
    overrides: (seed) => ({
      connectionId: fixture.otherConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'unbound data source',
    lookups: 'both',
    mutate: (seed) => seed,
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.otherDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'provider mismatch',
    lookups: 'both',
    mutate: (seed) => seed,
    overrides: (_seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'github',
      sourceType: 'github',
    }),
  },
  {
    label: 'sourceType mismatch',
    lookups: 'both',
    mutate: (seed) => ({ ...seed, scopes: [DRIVE_SCOPE, GMAIL_SCOPE] }),
    overrides: (_seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: 'gmail',
    }),
  },
  {
    label: 'missing drive scope',
    lookups: 'both',
    mutate: (seed) => ({ ...seed, scopes: [GMAIL_SCOPE] }),
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'missing gmail scope',
    lookups: 'both',
    mutate: (seed) => ({
      ...seed,
      scopes: [DRIVE_SCOPE],
      sourceType: 'gmail',
    }),
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'disconnected status',
    lookups: 'both',
    mutate: (seed) => ({
      ...seed,
      metadata: { status: 'disconnected' },
    }),
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'scopeMissing metadata',
    lookups: 'both',
    mutate: (seed) => ({
      ...seed,
      metadata: { scopeMissing: 'true' },
    }),
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
  {
    label: 'connectionError metadata',
    lookups: 'both',
    mutate: (seed) => ({
      ...seed,
      metadata: { connectionError: 'true' },
    }),
    overrides: (seed) => ({
      connectionId: fixture.driveConnectionId,
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: seed.sourceType,
    }),
  },
];

for (const rejectionCase of rejectionCases) {
  const lookupKinds =
    rejectionCase.lookups === 'explicit-only'
      ? (['explicit'] as const)
      : (['project', 'explicit'] as const);

  for (const lookupKind of lookupKinds) {
    test(`expired refreshable Google connection is rejected for ${rejectionCase.label} (${lookupKind})`, {
      skip: !databaseUrl,
    }, async () => {
      const seed = rejectionCase.mutate(driveSeed());

      await withGoogleFixture(seed, async ({ fetchCalls, sql }) => {
        const lookup = buildLookup(rejectionCase.overrides(seed));
        await assertLookupRejected(lookupKind, sql, lookup);
        assert.equal(fetchCalls.length, 0);
      });
    });
  }
}

test('Google refresh HTTP failure returns error without persisting refreshed token', {
  skip: !databaseUrl,
}, async () => {
  await withGoogleFixture(driveSeed(), async ({ fetchCalls, sql }) => {
    installGoogleRefreshFailureMock(fetchCalls, 'drive-refresh-token');

    await assert.rejects(
      () =>
        readProjectCollectionConnection({
          dataSourceId: fixture.driveDataSourceId,
          projectSlug: fixture.driveProjectSlug,
          provider: 'google',
          sourceType: 'drive',
          sql,
        }),
      /Google OAuth token refresh failed with status 400\./,
    );

    assert.equal(fetchCalls.length, 1);
    const [row] = await sql`
      SELECT access_token_secret AS "accessTokenSecret", expires_at AS "expiresAt"
      FROM public.oauth_connections
      WHERE id = ${fixture.driveConnectionId}
    `;
    assert.ok(row);
    assert.equal(decryptSecretValue(row.accessTokenSecret as string), 'expired-drive-access-token');
    assert.ok(new Date(row.expiresAt as string).getTime() < Date.now());
  });
});

test('expired GitHub connection stays rejected', { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  const fetchCalls: string[] = [];
  const envRestore = installTestEnv();
  const fetchRestore = installClosedFetchGuard(fetchCalls);
  try {
    await resetFixture(sql);
    await seedGitHubExpiredFixture(sql);

    const projectConnection = await readProjectCollectionConnection({
      dataSourceId: fixture.githubDataSourceId,
      projectSlug: fixture.githubProjectSlug,
      provider: 'github',
      sourceType: 'github',
      sql,
    });
    assert.equal(projectConnection, undefined);

    await assert.rejects(
      () =>
        readCollectionConnection({
          connectionId: fixture.githubConnectionId,
          dataSourceId: fixture.githubDataSourceId,
          projectSlug: fixture.githubProjectSlug,
          provider: 'github',
          sourceType: 'github',
          sql,
        }),
      /OAuth connection was not found for the project and source type\./,
    );
    assert.equal(fetchCalls.length, 0);
  } finally {
    fetchRestore();
    envRestore();
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

function buildLookup(overrides: LookupOverrides) {
  return {
    explicit: (sql: postgres.Sql) =>
      readCollectionConnection({
        connectionId: overrides.connectionId,
        dataSourceId: overrides.dataSourceId,
        projectSlug: overrides.projectSlug,
        provider: overrides.provider,
        sourceType: overrides.sourceType,
        sql,
      }),
    project: (sql: postgres.Sql) =>
      readProjectCollectionConnection({
        dataSourceId: overrides.dataSourceId,
        projectSlug: overrides.projectSlug,
        provider: overrides.provider,
        sourceType: overrides.sourceType,
        sql,
      }),
  };
}

async function readGoogleConnection(
  lookupKind: LookupKind,
  sql: postgres.Sql,
): Promise<{ token: string } | undefined> {
  if (lookupKind === 'project') {
    const connection = await readProjectCollectionConnection({
      dataSourceId: fixture.driveDataSourceId,
      projectSlug: fixture.driveProjectSlug,
      provider: 'google',
      sourceType: 'drive',
      sql,
    });
    return connection;
  }
  return readCollectionConnection({
    connectionId: fixture.driveConnectionId,
    dataSourceId: fixture.driveDataSourceId,
    projectSlug: fixture.driveProjectSlug,
    provider: 'google',
    sourceType: 'drive',
    sql,
  });
}

function readToken(connection: { token: string } | undefined): string | undefined {
  return connection?.token;
}

async function assertLookupRejected(
  lookupKind: LookupKind,
  sql: postgres.Sql,
  lookup = buildLookup({
    connectionId: fixture.driveConnectionId,
    dataSourceId: fixture.driveDataSourceId,
    projectSlug: fixture.driveProjectSlug,
    provider: 'google',
    sourceType: 'drive',
  }),
): Promise<void> {
  if (lookupKind === 'project') {
    const connection = await lookup.project(sql);
    assert.equal(connection, undefined);
    return;
  }
  await assert.rejects(
    () => lookup.explicit(sql),
    /OAuth connection was not found for the project and source type\./,
  );
}

async function withGoogleFixture(
  seed: GoogleConnectionSeed,
  run: (context: { fetchCalls: string[]; sql: postgres.Sql }) => Promise<void>,
): Promise<void> {
  const sql = postgres(databaseUrl as string, { max: 1 });
  const fetchCalls: string[] = [];
  const envRestore = installTestEnv();
  const fetchRestore = installClosedFetchGuard(fetchCalls);
  try {
    await resetFixture(sql);
    await seedGoogleFixture(sql, seed);
    await run({ fetchCalls, sql });
  } finally {
    fetchRestore();
    envRestore();
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
}

function installTestEnv(): () => void {
  const previous = {
    authSecret: process.env.AUTH_SECRET,
    connectionSecretKey: process.env.CONNECTION_SECRET_KEY,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
  process.env.CONNECTION_SECRET_KEY = TEST_SECRET_KEY;
  process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;
  return () => {
    if (previous.authSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = previous.authSecret;
    }
    if (previous.connectionSecretKey === undefined) {
      delete process.env.CONNECTION_SECRET_KEY;
    } else {
      process.env.CONNECTION_SECRET_KEY = previous.connectionSecretKey;
    }
    if (previous.googleClientId === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = previous.googleClientId;
    }
    if (previous.googleClientSecret === undefined) {
      delete process.env.GOOGLE_CLIENT_SECRET;
    } else {
      process.env.GOOGLE_CLIENT_SECRET = previous.googleClientSecret;
    }
  };
}

function installClosedFetchGuard(_fetchCalls: string[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`Unexpected network request: ${resolveFetchUrl(input)}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installGoogleRefreshMock(
  fetchCalls: string[],
  input: { accessToken: string; refreshToken: string },
): void {
  globalThis.fetch = async (requestInput, init) => {
    assertGoogleRefreshRequest(requestInput, init, input.refreshToken);
    fetchCalls.push('refresh');
    return new Response(JSON.stringify({ access_token: input.accessToken, expires_in: 3600 }), {
      status: 200,
    });
  };
}

function installGoogleRefreshFailureMock(fetchCalls: string[], refreshToken: string): void {
  globalThis.fetch = async (requestInput, init) => {
    assertGoogleRefreshRequest(requestInput, init, refreshToken);
    fetchCalls.push('refresh');
    return new Response('invalid_grant', { status: 400, statusText: 'Bad Request' });
  };
}

function assertGoogleRefreshRequest(
  requestInput: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  refreshToken: string,
): void {
  const url = resolveFetchUrl(requestInput);
  assert.equal(url, GOOGLE_TOKEN_URL);
  assert.equal(init?.method ?? 'GET', 'POST');
  const body = init?.body;
  assert.ok(body instanceof URLSearchParams || typeof body === 'string');
  const params = body instanceof URLSearchParams ? body : new URLSearchParams(body as string);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), refreshToken);
  assert.equal(params.get('client_id'), GOOGLE_CLIENT_ID);
  assert.equal(params.get('client_secret'), GOOGLE_CLIENT_SECRET);
}

function resolveFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

async function seedGoogleFixture(sql: postgres.Sql, seed: GoogleConnectionSeed): Promise<void> {
  await seedUser(sql);
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${seed.projectId},
      ${seed.projectSlug},
      ${seed.projectSlug},
      ${`graph_${seed.projectSlug.replaceAll('-', '_')}`},
      ${seed.projectSlug},
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixture.otherProjectId},
      ${fixture.otherProjectSlug},
      ${fixture.otherProjectSlug},
      'graph_issue_731_other_project',
      ${fixture.otherProjectSlug},
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.oauth_connections (
      id,
      project_id,
      user_id,
      provider,
      provider_account_id,
      scopes,
      metadata,
      access_token_secret,
      refresh_token_secret,
      expires_at
    )
    VALUES (
      ${seed.connectionId},
      ${seed.projectId},
      ${fixture.userId},
      'google',
      'google-account-731',
      ${sql.array(seed.scopes, 25)},
      ${sql.json((seed.metadata ?? { status: 'connected' }) as postgres.JSONValue)},
      ${encryptSecretValue(seed.accessToken)},
      ${refreshTokenSecretValue(seed.refreshToken)},
      ${seed.expiresAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.oauth_connections (
      id,
      project_id,
      user_id,
      provider,
      provider_account_id,
      scopes,
      metadata,
      access_token_secret,
      refresh_token_secret,
      expires_at
    )
    VALUES (
      ${fixture.otherConnectionId},
      ${fixture.otherProjectId},
      ${fixture.userId},
      'google',
      'google-account-731-other',
      ${sql.array([DRIVE_SCOPE], 25)},
      ${sql.json({ status: 'connected' })},
      ${encryptSecretValue('other-access-token')},
      ${encryptSecretValue('other-refresh-token')},
      ${pastDate()}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_sources (
      id,
      project_id,
      owner_user_id,
      connection_id,
      source_type,
      name,
      config,
      enabled
    )
    VALUES (
      ${seed.dataSourceId},
      ${seed.projectId},
      ${fixture.userId},
      ${seed.connectionId},
      ${seed.sourceType},
      ${`${seed.sourceType}-731`},
      ${sql.json({})},
      true
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_sources (
      id,
      project_id,
      owner_user_id,
      connection_id,
      source_type,
      name,
      config,
      enabled
    )
    VALUES (
      ${fixture.otherDataSourceId},
      ${seed.projectId},
      ${fixture.userId},
      NULL,
      ${seed.sourceType},
      'unbound-731',
      ${sql.json({})},
      true
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

function refreshTokenSecretValue(refreshToken?: string | null): string | null {
  if (refreshToken === undefined || refreshToken === null) {
    return null;
  }
  if (refreshToken === '') {
    return '';
  }
  return encryptSecretValue(refreshToken);
}

async function seedGitHubExpiredFixture(sql: postgres.Sql): Promise<void> {
  await seedUser(sql);
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixture.githubProjectId},
      ${fixture.githubProjectSlug},
      ${fixture.githubProjectSlug},
      'graph_issue_731_github_expired',
      ${fixture.githubProjectSlug},
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.oauth_connections (
      id,
      project_id,
      user_id,
      provider,
      provider_account_id,
      scopes,
      metadata,
      access_token_secret,
      refresh_token_secret,
      expires_at
    )
    VALUES (
      ${fixture.githubConnectionId},
      ${fixture.githubProjectId},
      ${fixture.userId},
      'github',
      'github-account-731',
      ${sql.array([], 25)},
      ${sql.json({ installationId: '731-installation', status: 'connected' })},
      ${encryptSecretValue('expired-github-access-token')},
      NULL,
      ${pastDate()}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_sources (
      id,
      project_id,
      owner_user_id,
      connection_id,
      source_type,
      name,
      config,
      enabled
    )
    VALUES (
      ${fixture.githubDataSourceId},
      ${fixture.githubProjectId},
      ${fixture.userId},
      ${fixture.githubConnectionId},
      'github',
      'github-731',
      ${sql.json({ repository: 'example-org/issue-731' })},
      true
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedUser(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${fixture.userId}, 'issue-731-collection@example.test', 'Issue 731 Collection', 'admin')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function resetFixture(sql: postgres.Sql): Promise<void> {
  const projectIds = [
    fixture.driveProjectId,
    fixture.gmailProjectId,
    fixture.githubProjectId,
    fixture.otherProjectId,
  ];
  const connectionIds = [
    fixture.driveConnectionId,
    fixture.gmailConnectionId,
    fixture.githubConnectionId,
    fixture.otherConnectionId,
  ];
  const dataSourceIds = [
    fixture.driveDataSourceId,
    fixture.gmailDataSourceId,
    fixture.githubDataSourceId,
    fixture.otherDataSourceId,
  ];
  await sql`DELETE FROM public.data_sources WHERE id = ANY(${dataSourceIds}::uuid[])`;
  await sql`DELETE FROM public.oauth_connections WHERE id = ANY(${connectionIds}::uuid[])`;
  await sql`DELETE FROM public.projects WHERE id = ANY(${projectIds}::uuid[])`;
  await sql`DELETE FROM public.users WHERE id = ${fixture.userId}`;
}

async function assertStoredGoogleToken(
  sql: postgres.Sql,
  connectionId: string,
  expectedToken: string,
): Promise<void> {
  const [row] = await sql`
    SELECT access_token_secret AS "accessTokenSecret", expires_at AS "expiresAt"
    FROM public.oauth_connections
    WHERE id = ${connectionId}
  `;
  assert.ok(row);
  assert.equal(decryptSecretValue(row.accessTokenSecret as string), expectedToken);
  assert.ok(new Date(row.expiresAt as string).getTime() > Date.now());
}

function encryptSecretValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedSecret = {
    alg: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
  return `${ENCRYPTED_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function decryptSecretValue(secretValue: string): string {
  const encoded = secretValue.slice(ENCRYPTED_PREFIX.length);
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as EncryptedSecret;
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function secretKey(): Buffer {
  return createHash('sha256').update(TEST_SECRET_KEY).digest();
}

function pastDate(): Date {
  return new Date(Date.now() - 2 * 60 * 60 * 1000);
}

function futureDate(): Date {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}
