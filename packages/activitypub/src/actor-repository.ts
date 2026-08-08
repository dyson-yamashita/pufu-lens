import { exportJwk, type generateCryptoKeyPair, importJwk } from '@fedify/fedify';
import type postgres from 'postgres';
import {
  ActivityPubPreferredUsernameConflictError,
  ActivityPubProjectNotPublicError,
} from './activitypub-errors.ts';
import {
  createActorKeyMaterial,
  decryptPrivateJwk,
  type EncryptedPrivateKeyBlob,
} from './key-encryption.ts';
import {
  type ActivityPubActor,
  type ActivityPubInstanceConfig,
  type ActivityPubProjectScope,
  type ObjectRepresentation,
  type PublicReportArticle,
  parseActivityPubActorEncryptedKeyRow,
  parseActivityPubActorRow,
  parseActivityPubInstanceConfigRow,
  parseActivityPubProjectScopeRow,
  parseOptionalRow,
  parsePublicReportArticleRow,
  parseRequiredRow,
} from './schema.ts';

export type FedifyActorKeyPair = Awaited<ReturnType<typeof generateCryptoKeyPair>>;

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

const AGGREGATE_USERNAME = 'all';

type RepositoryExecutorConfig =
  | {
      kind: 'root';
      sql: postgres.Sql;
      encryptionKey: Buffer;
    }
  | {
      kind: 'transaction';
      sql: postgres.TransactionSql;
      encryptionKey: Buffer;
    };

/**
 * ActivityPub persistence boundary. Enable/disable mutations lock the exact
 * project scope with `FOR UPDATE` inside a single PostgreSQL transaction.
 */
export type ActivityPubRepository = {
  runInTransaction<T>(callback: (repository: ActivityPubRepository) => Promise<T>): Promise<T>;
  ensureAggregateActor(): Promise<ActivityPubActor>;
  enableProjectActor(input: {
    projectId: string;
    projectSlug: string;
    preferredUsername?: string;
  }): Promise<ActivityPubActor>;
  disableProjectActor(input: { projectId: string; projectSlug: string }): Promise<ActivityPubActor>;
  findRemotelyVisibleActorByUsername(
    preferredUsername: string,
  ): Promise<ActivityPubActor | undefined>;
  importActorCryptoKeyPair(actorId: string): Promise<FedifyActorKeyPair>;
  findPublicReportArticle(reportId: string): Promise<PublicReportArticle | undefined>;
  getInstanceConfig(): Promise<ActivityPubInstanceConfig>;
  updateInstanceRepresentation(
    objectRepresentation: ObjectRepresentation,
  ): Promise<ActivityPubInstanceConfig>;
};

/** Creates the PostgreSQL-backed ActivityPub repository for production use. */
export function createPostgresActivityPubRepository(input: {
  sql: postgres.Sql;
  encryptionKey: Buffer;
}): ActivityPubRepository {
  return createRepositoryExecutor({
    kind: 'root',
    sql: input.sql,
    encryptionKey: input.encryptionKey,
  });
}

/**
 * Creates a transaction-bound ActivityPub repository for rollback-safe integration tests.
 * Mutations run on the supplied transaction and never start a nested root transaction.
 */
export function createPostgresActivityPubTransactionRepository(input: {
  sql: postgres.TransactionSql;
  encryptionKey: Buffer;
}): ActivityPubRepository {
  return createRepositoryExecutor({
    kind: 'transaction',
    sql: input.sql,
    encryptionKey: input.encryptionKey,
  });
}

function createRepositoryExecutor(config: RepositoryExecutorConfig): ActivityPubRepository {
  const encryptionKey = config.encryptionKey;

  return {
    runInTransaction<T>(callback: (repository: ActivityPubRepository) => Promise<T>): Promise<T> {
      if (config.kind === 'transaction') {
        return callback(createRepositoryExecutor(config));
      }
      return config.sql.begin(async (tx) =>
        callback(
          createRepositoryExecutor({
            kind: 'transaction',
            sql: tx,
            encryptionKey,
          }),
        ),
      ) as Promise<T>;
    },
    ensureAggregateActor: () => ensureAggregateActor({ sql: config.sql, encryptionKey }),
    enableProjectActor: (params) =>
      runProjectActorMutation(config, (sql) =>
        enableProjectActorOnExecutor({
          sql,
          encryptionKey,
          projectId: params.projectId,
          projectSlug: params.projectSlug,
          preferredUsername: params.preferredUsername,
        }),
      ),
    disableProjectActor: (params) =>
      runProjectActorMutation(config, (sql) =>
        disableProjectActorOnExecutor({
          sql,
          projectId: params.projectId,
          projectSlug: params.projectSlug,
        }),
      ),
    findRemotelyVisibleActorByUsername: (preferredUsername) =>
      findRemotelyVisibleActorByUsername({ sql: config.sql, preferredUsername }),
    importActorCryptoKeyPair: (actorId) =>
      importActorCryptoKeyPair({ sql: config.sql, encryptionKey, actorId }),
    findPublicReportArticle: (reportId) => findPublicReportArticle({ sql: config.sql, reportId }),
    getInstanceConfig: () => getInstanceConfig({ sql: config.sql }),
    updateInstanceRepresentation: (objectRepresentation) =>
      updateInstanceRepresentation({ sql: config.sql, objectRepresentation }),
  };
}

async function runProjectActorMutation<T>(
  config: RepositoryExecutorConfig,
  mutation: (sql: SqlExecutor) => Promise<T>,
): Promise<T> {
  if (config.kind === 'transaction') {
    return mutation(config.sql);
  }
  return config.sql.begin(async (tx) => mutation(tx)) as Promise<T>;
}

async function enableProjectActorOnExecutor(input: {
  sql: SqlExecutor;
  encryptionKey: Buffer;
  projectId: string;
  projectSlug: string;
  preferredUsername?: string;
}): Promise<ActivityPubActor> {
  const scope = await lockProjectScopeForUpdate({
    sql: input.sql,
    projectId: input.projectId,
    projectSlug: input.projectSlug,
  });
  if (scope.visibility !== 'public') {
    throw new ActivityPubProjectNotPublicError(scope.id);
  }
  return enableProjectActorInLockedScope({
    sql: input.sql,
    encryptionKey: input.encryptionKey,
    scope,
    preferredUsername: input.preferredUsername,
  });
}

async function disableProjectActorOnExecutor(input: {
  sql: SqlExecutor;
  projectId: string;
  projectSlug: string;
}): Promise<ActivityPubActor> {
  await lockProjectScopeForUpdate({
    sql: input.sql,
    projectId: input.projectId,
    projectSlug: input.projectSlug,
  });
  return disableProjectActorInLockedScope({
    sql: input.sql,
    projectId: input.projectId,
  });
}

/** Locks the exact project id+slug row for update and returns the parsed scope. */
export async function lockProjectScopeForUpdate(input: {
  sql: SqlExecutor;
  projectId: string;
  projectSlug: string;
}): Promise<ActivityPubProjectScope> {
  const rows = (await input.sql`
    SELECT
      id::text AS id,
      slug,
      name,
      COALESCE(visibility, 'private') AS visibility
    FROM public.projects
    WHERE id = ${input.projectId}::uuid
      AND slug = ${input.projectSlug}
    FOR UPDATE
  `) as readonly unknown[];
  return parseRequiredRow(rows, parseActivityPubProjectScopeRow);
}

async function enableProjectActorInLockedScope(input: {
  sql: SqlExecutor;
  encryptionKey: Buffer;
  scope: ActivityPubProjectScope;
  preferredUsername?: string;
}): Promise<ActivityPubActor> {
  const existing = await findProjectActorByProjectId(input.sql, input.scope.id);
  if (existing) {
    const preferredUsername =
      input.preferredUsername === undefined ? existing.preferredUsername : input.preferredUsername;
    if (existing.preferredUsername !== preferredUsername) {
      throw new Error('Existing project actor username is immutable');
    }
    if (!existing.enabled) {
      return enableExistingActor(input.sql, existing.id);
    }
    return existing;
  }

  const preferredUsername = input.preferredUsername ?? input.scope.slug;
  if (preferredUsername === AGGREGATE_USERNAME) {
    throw new Error('Project actor preferred username cannot be reserved name all');
  }

  const keyMaterial = await createActorKeyMaterial(input.encryptionKey);
  const inserted = (await input.sql`
    INSERT INTO public.activitypub_actors (
      project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      encrypted_private_key,
      created_at,
      updated_at
    )
    VALUES (
      ${input.scope.id}::uuid,
      'project',
      ${preferredUsername},
      ${input.scope.name},
      true,
      ${keyMaterial.publicKeyPem},
      ${bindEncryptedPrivateKey(input.sql, keyMaterial.encryptedPrivateKey)},
      now(),
      now()
    )
    ON CONFLICT DO NOTHING
    RETURNING
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
  `) as readonly unknown[];

  const created = parseOptionalRow(inserted, parseActivityPubActorRow);
  if (created) {
    return created;
  }

  const reloaded = await findProjectActorByProjectId(input.sql, input.scope.id);
  if (!reloaded) {
    const conflict = await findActorByPreferredUsername(input.sql, preferredUsername);
    if (conflict) {
      throw new ActivityPubPreferredUsernameConflictError({
        preferredUsername,
        ownerProjectId: conflict.projectId,
      });
    }
    throw new Error('Failed to enable project ActivityPub actor.');
  }
  if (reloaded.preferredUsername !== preferredUsername) {
    throw new Error('Existing project actor username is immutable');
  }
  if (!reloaded.enabled) {
    return enableExistingActor(input.sql, reloaded.id);
  }
  return reloaded;
}

async function disableProjectActorInLockedScope(input: {
  sql: SqlExecutor;
  projectId: string;
}): Promise<ActivityPubActor> {
  const existing = await findProjectActorByProjectId(input.sql, input.projectId);
  if (!existing) {
    throw new Error('Project ActivityPub actor was not found.');
  }
  if (!existing.enabled) {
    return existing;
  }

  const rows = (await input.sql`
    UPDATE public.activitypub_actors
    SET enabled = false,
        updated_at = now()
    WHERE id = ${existing.id}::uuid
    RETURNING
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
  `) as readonly unknown[];
  return parseRequiredRow(rows, parseActivityPubActorRow);
}

async function ensureAggregateActor(input: {
  sql: SqlExecutor;
  encryptionKey: Buffer;
}): Promise<ActivityPubActor> {
  const existing = await findAggregateActor(input.sql);
  if (existing) {
    if (!existing.enabled) {
      return enableExistingActor(input.sql, existing.id);
    }
    return existing;
  }

  const keyMaterial = await createActorKeyMaterial(input.encryptionKey);
  const inserted = (await input.sql`
    INSERT INTO public.activitypub_actors (
      project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      encrypted_private_key,
      created_at,
      updated_at
    )
    VALUES (
      NULL,
      'aggregate',
      ${AGGREGATE_USERNAME},
      'All Projects',
      true,
      ${keyMaterial.publicKeyPem},
      ${bindEncryptedPrivateKey(input.sql, keyMaterial.encryptedPrivateKey)},
      now(),
      now()
    )
    ON CONFLICT DO NOTHING
    RETURNING
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
  `) as readonly unknown[];

  const created = parseOptionalRow(inserted, parseActivityPubActorRow);
  if (created) {
    return created;
  }

  const reloaded = await findAggregateActor(input.sql);
  if (!reloaded) {
    throw new Error('Failed to ensure aggregate ActivityPub actor.');
  }
  if (!reloaded.enabled) {
    return enableExistingActor(input.sql, reloaded.id);
  }
  return reloaded;
}

async function findRemotelyVisibleActorByUsername(input: {
  sql: SqlExecutor;
  preferredUsername: string;
}): Promise<ActivityPubActor | undefined> {
  const rows = (await input.sql`
    SELECT
      a.id::text AS id,
      a.project_id::text AS project_id,
      a.kind,
      a.preferred_username,
      a.display_name,
      a.enabled,
      a.public_key_pem,
      a.created_at,
      a.updated_at
    FROM public.activitypub_actors a
    LEFT JOIN public.projects p
      ON p.id = a.project_id
    WHERE a.preferred_username = ${input.preferredUsername}
      AND a.enabled = true
      AND (
        a.kind = 'aggregate'
        OR (a.kind = 'project' AND COALESCE(p.visibility, 'private') = 'public')
      )
    LIMIT 1
  `) as readonly unknown[];
  return parseOptionalRow(rows, parseActivityPubActorRow);
}

async function importActorCryptoKeyPair(input: {
  sql: SqlExecutor;
  encryptionKey: Buffer;
  actorId: string;
}): Promise<FedifyActorKeyPair> {
  const rows = (await input.sql`
    SELECT encrypted_private_key, public_key_pem
    FROM public.activitypub_actors
    WHERE id = ${input.actorId}::uuid
    LIMIT 1
  `) as readonly unknown[];
  const keyRow = parseRequiredRow(rows, parseActivityPubActorEncryptedKeyRow);
  const privateJwk = decryptPrivateJwk({
    encrypted: keyRow.encryptedPrivateKey,
    encryptionKey: input.encryptionKey,
  });
  const publicJwk = await importSpkiToJwk(keyRow.publicKeyPem);
  const [privateKey, publicKey] = await Promise.all([
    importJwk(privateJwk, 'private'),
    importJwk(publicJwk, 'public'),
  ]);
  return { privateKey, publicKey };
}

async function findPublicReportArticle(input: {
  sql: SqlExecutor;
  reportId: string;
}): Promise<PublicReportArticle | undefined> {
  const rows = (await input.sql`
    SELECT
      r.id::text AS report_id,
      p.id::text AS project_id,
      p.slug AS project_slug,
      a.preferred_username,
      r.title,
      COALESCE(r.summary, '') AS summary,
      r.created_at AS published_at
    FROM public.reports r
    JOIN public.projects p
      ON p.id = r.project_id
    JOIN public.activitypub_actors a
      ON a.project_id = p.id
     AND a.kind = 'project'
    WHERE r.id = ${input.reportId}::uuid
      AND r.is_public = true
      AND COALESCE(p.visibility, 'private') = 'public'
      AND a.enabled = true
    LIMIT 1
  `) as readonly unknown[];
  return parseOptionalRow(rows, parsePublicReportArticleRow);
}

async function getInstanceConfig(input: { sql: SqlExecutor }): Promise<ActivityPubInstanceConfig> {
  const rows = (await input.sql`
    SELECT id, object_representation, representation_locked_at, created_at, updated_at
    FROM public.activitypub_instance_config
    WHERE id = 1
    LIMIT 1
  `) as readonly unknown[];
  return parseRequiredRow(rows, parseActivityPubInstanceConfigRow);
}

async function updateInstanceRepresentation(input: {
  sql: SqlExecutor;
  objectRepresentation: ObjectRepresentation;
}): Promise<ActivityPubInstanceConfig> {
  const rows = (await input.sql`
    UPDATE public.activitypub_instance_config
    SET object_representation = ${input.objectRepresentation},
        updated_at = now()
    WHERE id = 1
      AND representation_locked_at IS NULL
    RETURNING id, object_representation, representation_locked_at, created_at, updated_at
  `) as readonly unknown[];
  return parseRequiredRow(rows, parseActivityPubInstanceConfigRow);
}

async function findActorByPreferredUsername(
  sql: SqlExecutor,
  preferredUsername: string,
): Promise<ActivityPubActor | undefined> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
    FROM public.activitypub_actors
    WHERE preferred_username = ${preferredUsername}
    LIMIT 1
  `) as readonly unknown[];
  return parseOptionalRow(rows, parseActivityPubActorRow);
}

async function findAggregateActor(sql: SqlExecutor): Promise<ActivityPubActor | undefined> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
    FROM public.activitypub_actors
    WHERE kind = 'aggregate'
    LIMIT 1
  `) as readonly unknown[];
  return parseOptionalRow(rows, parseActivityPubActorRow);
}

async function findProjectActorByProjectId(
  sql: SqlExecutor,
  projectId: string,
): Promise<ActivityPubActor | undefined> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
    FROM public.activitypub_actors
    WHERE kind = 'project'
      AND project_id = ${projectId}::uuid
    LIMIT 1
  `) as readonly unknown[];
  return parseOptionalRow(rows, parseActivityPubActorRow);
}

async function enableExistingActor(sql: SqlExecutor, actorId: string): Promise<ActivityPubActor> {
  const rows = (await sql`
    UPDATE public.activitypub_actors
    SET enabled = true,
        updated_at = now()
    WHERE id = ${actorId}::uuid
    RETURNING
      id::text AS id,
      project_id::text AS project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      created_at,
      updated_at
  `) as readonly unknown[];
  return parseRequiredRow(rows, parseActivityPubActorRow);
}

function bindEncryptedPrivateKey(sql: SqlExecutor, encryptedPrivateKey: EncryptedPrivateKeyBlob) {
  // encryptPrivateJwk returns a JSON-safe EncryptedPrivateKeyBlob structure.
  return sql.json(encryptedPrivateKey as never);
}

async function importSpkiToJwk(publicKeyPem: string) {
  const pemBody = publicKeyPem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replaceAll('\n', '')
    .trim();
  const der = Buffer.from(pemBody, 'base64');
  const key = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  );
  return exportJwk(key);
}
