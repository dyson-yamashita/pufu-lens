import assert from 'node:assert/strict';
import { exportSpki } from '@fedify/vocab-runtime';
import postgres from 'postgres';
import {
  type ActivityPubRepository,
  createPostgresActivityPubRepository,
  createPostgresActivityPubTransactionRepository,
} from './actor-repository.ts';
import { createActivityPubUseCases } from './actor-use-cases.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping actor repository DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for actor repository DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const encryptionKey = Buffer.alloc(32, 11);
const fixtureProjectId = '4f000000-0000-0000-0000-00000000db01';
const fixtureProjectSlug = 'activitypub-db-fixture';
const secondaryFixtureProjectId = '4f000000-0000-0000-0000-00000000db02';
const secondaryFixtureProjectSlug = 'activitypub-db-fixture-2';
const sharedPreferredUsername = 'ap-db-shared-username';
const fixtureActivityUri = 'https://lens.test/activitypub/activities/create/db-fixture-lock';
const fixtureKeyMaterial =
  '{"version":1,"algorithm":"aes-256-gcm","iv":"aXY=","ciphertext":"YQ==","tag":"dGFn"}';
const transactionFixtureProjectId = '4f000000-0000-0000-0000-00000000db03';
const transactionFixtureProjectSlug = 'activitypub-tx-rollback-fixture';

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixtureProjects(sql);
    await assertProjectActorKeyStabilityAcrossClients();
    await assertTransactionBoundEnableRollsBack(sql);
    await assertCustomUsernameReenablePreservesActor(sql);
    await assertRepresentationLockGuards(sql);
    await assertActorConstraintViolations(sql);
    console.log('activitypub actor repository DB tests passed');
  } finally {
    await cleanupFixtureProjects(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanupFixtureProjects(sql: postgres.Sql) {
  await sql`DELETE FROM public.projects WHERE id IN (${fixtureProjectId}::uuid, ${secondaryFixtureProjectId}::uuid, ${transactionFixtureProjectId}::uuid)`;
}

async function runRollbackTransaction(
  sql: postgres.Sql,
  callback: (input: {
    tx: postgres.TransactionSql;
    repository: ActivityPubRepository;
  }) => Promise<void>,
): Promise<void> {
  const rollbackToken = 'rollback activitypub db test';
  await sql
    .begin(async (tx) => {
      const repository = createPostgresActivityPubTransactionRepository({
        sql: tx,
        encryptionKey,
      });
      await callback({ tx, repository });
      throw new Error(rollbackToken);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== rollbackToken) {
        throw error;
      }
    });
}

async function cleanupTransactionFixtureProject(sql: postgres.Sql) {
  await sql`DELETE FROM public.projects WHERE id = ${transactionFixtureProjectId}::uuid`;
}

async function assertTransactionBoundEnableRollsBack(sql: postgres.Sql) {
  await cleanupTransactionFixtureProject(sql);
  await runRollbackTransaction(sql, async ({ tx, repository }) => {
    await tx`
      INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
      VALUES (
        ${transactionFixtureProjectId}::uuid,
        ${transactionFixtureProjectSlug},
        'Transaction Rollback Fixture',
        'graph_activitypub_tx_rollback_fixture',
        ${transactionFixtureProjectSlug},
        'public'
      )
    `;
    const actor = await repository.enableProjectActor({
      projectId: transactionFixtureProjectId,
      projectSlug: transactionFixtureProjectSlug,
    });
    assert.ok(actor.id);
  });

  const rows = await sql`
    SELECT id::text AS id
    FROM public.activitypub_actors
    WHERE project_id = ${transactionFixtureProjectId}::uuid
  `;
  assert.equal(rows.length, 0);
  await cleanupTransactionFixtureProject(sql);
}

async function assertCustomUsernameReenablePreservesActor(sql: postgres.Sql) {
  const customUsername = 'ap-db-custom-username';
  const reservedSlug = 'all';
  await sql`DELETE FROM public.projects WHERE id = ${fixtureProjectId}::uuid`;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixtureProjectId}::uuid,
      ${reservedSlug},
      'Reserved Slug Fixture',
      'graph_activitypub_reserved_slug_fixture',
      ${reservedSlug},
      'public'
    )
  `;

  const repository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const enabled = await repository.enableProjectActor({
    projectId: fixtureProjectId,
    projectSlug: reservedSlug,
    preferredUsername: customUsername,
  });
  const disabled = await repository.disableProjectActor({
    projectId: fixtureProjectId,
    projectSlug: reservedSlug,
  });
  const reenabled = await repository.enableProjectActor({
    projectId: fixtureProjectId,
    projectSlug: reservedSlug,
  });

  assert.equal(disabled.enabled, false);
  assert.equal(reenabled.id, enabled.id);
  assert.equal(reenabled.preferredUsername, customUsername);
  assert.equal(reenabled.publicKeyPem, enabled.publicKeyPem);

  await assert.rejects(
    () =>
      repository.enableProjectActor({
        projectId: fixtureProjectId,
        projectSlug: reservedSlug,
        preferredUsername: 'another-username',
      }),
    /immutable/i,
  );

  await sql`DELETE FROM public.projects WHERE id = ${fixtureProjectId}::uuid`;
}

async function assertProjectActorKeyStabilityAcrossClients() {
  let firstActorId = '';
  let firstPublicKeyPem = '';

  const setupSql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixtureProjects(setupSql);
    await setupSql`
      INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
      VALUES (
        ${fixtureProjectId}::uuid,
        ${fixtureProjectSlug},
        'ActivityPub DB Fixture',
        'graph_activitypub_db_fixture',
        ${fixtureProjectSlug},
        'public'
      )
    `;
    const repositoryA = createPostgresActivityPubRepository({ sql: setupSql, encryptionKey });
    const first = await repositoryA.enableProjectActor({
      projectId: fixtureProjectId,
      projectSlug: fixtureProjectSlug,
    });
    firstActorId = first.id;
    firstPublicKeyPem = first.publicKeyPem;
    assert.equal(first.displayName, 'ActivityPub DB Fixture');
  } finally {
    await setupSql.end({ timeout: 5 });
  }

  const reloadSql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    const repositoryB = createPostgresActivityPubRepository({ sql: reloadSql, encryptionKey });
    const second = await repositoryB.enableProjectActor({
      projectId: fixtureProjectId,
      projectSlug: fixtureProjectSlug,
    });
    assert.equal(second.id, firstActorId);
    assert.equal(second.publicKeyPem, firstPublicKeyPem);
    const keyPair = await repositoryB.importActorCryptoKeyPair(second.id);
    const publicKeyPem = await exportSpki(keyPair.publicKey);
    assert.equal(publicKeyPem, firstPublicKeyPem);
  } finally {
    await cleanupFixtureProjects(reloadSql);
    await reloadSql.end({ timeout: 5 });
  }
}

async function assertRepresentationLockGuards(sql: postgres.Sql) {
  await runRollbackTransaction(sql, async ({ tx, repository }) => {
    const aggregate = await repository.ensureAggregateActor();
    await tx`
      INSERT INTO public.activitypub_activities (
        activity_uri,
        activity_type,
        actor_uri,
        local_actor_id,
        direction,
        payload_json,
        processing_status
      )
      VALUES (
        ${fixtureActivityUri},
        'Create',
        ${'https://lens.test/activitypub/actors/all'},
        ${aggregate.id}::uuid,
        'outbound',
        '{}'::jsonb,
        'pending'
      )
    `;

    const useCases = createActivityPubUseCases({ encryptionKey, repository });
    await assert.rejects(
      () => useCases.updateInstanceRepresentation('note'),
      /locked/i,
      'use-case rejects note change after lock',
    );
  });

  await runRollbackTransaction(sql, async ({ tx, repository }) => {
    const aggregate = await repository.ensureAggregateActor();
    await tx`
      INSERT INTO public.activitypub_activities (
        activity_uri,
        activity_type,
        actor_uri,
        local_actor_id,
        direction,
        payload_json,
        processing_status
      )
      VALUES (
        ${`${fixtureActivityUri}-sql`},
        'Create',
        ${'https://lens.test/activitypub/actors/all'},
        ${aggregate.id}::uuid,
        'outbound',
        '{}'::jsonb,
        'pending'
      )
    `;

    await assert.rejects(
      async () => {
        await tx`
          UPDATE public.activitypub_instance_config
          SET object_representation = 'note'
          WHERE id = 1
        `;
      },
      /cannot change after lock/i,
      'direct SQL update rejects representation change after lock',
    );
  });

  await runRollbackTransaction(sql, async ({ tx }) => {
    await assert.rejects(
      async () => {
        await tx`
          INSERT INTO public.activitypub_instance_config (id, object_representation)
          VALUES (2, 'article')
        `;
      },
      /singleton|check constraint|violates/i,
      'singleton id=2 insert is rejected',
    );
  });

  await runRollbackTransaction(sql, async ({ tx }) => {
    await assert.rejects(
      async () => {
        await tx`DELETE FROM public.activitypub_instance_config WHERE id = 1`;
      },
      /cannot be deleted/i,
      'singleton delete is rejected',
    );
  });
}

async function insertFixtureProjects(tx: postgres.TransactionSql) {
  await tx`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES
      (
        ${fixtureProjectId}::uuid,
        ${fixtureProjectSlug},
        'ActivityPub DB Fixture',
        'graph_activitypub_db_fixture',
        ${fixtureProjectSlug},
        'public'
      ),
      (
        ${secondaryFixtureProjectId}::uuid,
        ${secondaryFixtureProjectSlug},
        'ActivityPub DB Fixture 2',
        'graph_activitypub_db_fixture_2',
        ${secondaryFixtureProjectSlug},
        'public'
      )
  `;
}

async function assertActorConstraintViolations(sql: postgres.Sql) {
  const cases: Array<{
    label: string;
    run: (tx: postgres.TransactionSql) => Promise<unknown>;
    setup?: (input: {
      tx: postgres.TransactionSql;
      repository: ActivityPubRepository;
    }) => Promise<void>;
  }> = [
    {
      label: 'aggregate duplicate',
      setup: async ({ repository }) => {
        await repository.ensureAggregateActor();
      },
      run: (tx) =>
        tx.unsafe(`
          INSERT INTO public.activitypub_actors (kind, preferred_username, display_name, enabled, public_key_pem, encrypted_private_key)
          SELECT 'aggregate', 'all', 'All Projects', true, 'pem', '${fixtureKeyMaterial}'::jsonb
          FROM public.activitypub_actors
          WHERE kind = 'aggregate'
          LIMIT 1
        `),
    },
    {
      label: 'project actor duplicate per project',
      setup: async ({ tx }) => {
        await insertFixtureProjects(tx);
        await tx`
          INSERT INTO public.activitypub_actors (
            project_id,
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            ${fixtureProjectId}::uuid,
            'project',
            'ap-db-first-actor',
            'First',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `;
      },
      run: (tx) =>
        tx`
          INSERT INTO public.activitypub_actors (
            project_id,
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            ${fixtureProjectId}::uuid,
            'project',
            'ap-db-second-actor',
            'Second',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `,
    },
    {
      label: 'preferred username collision across projects',
      setup: async ({ tx }) => {
        await insertFixtureProjects(tx);
        await tx`
          INSERT INTO public.activitypub_actors (
            project_id,
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            ${fixtureProjectId}::uuid,
            'project',
            ${sharedPreferredUsername},
            'First',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `;
      },
      run: (tx) =>
        tx`
          INSERT INTO public.activitypub_actors (
            project_id,
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            ${secondaryFixtureProjectId}::uuid,
            'project',
            ${sharedPreferredUsername},
            'Second',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `,
    },
    {
      label: 'aggregate with project_id',
      setup: async ({ tx }) => {
        await insertFixtureProjects(tx);
      },
      run: (tx) =>
        tx`
          INSERT INTO public.activitypub_actors (
            project_id,
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            ${fixtureProjectId}::uuid,
            'aggregate',
            'all',
            'Bad Aggregate',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `,
    },
    {
      label: 'project without project_id',
      run: (tx) =>
        tx`
          INSERT INTO public.activitypub_actors (
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            'project',
            'ap-db-missing-project',
            'Bad Project',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `,
    },
    {
      label: 'aggregate username not all',
      run: (tx) =>
        tx`
          INSERT INTO public.activitypub_actors (
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            'aggregate',
            'not-all',
            'Bad Aggregate',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `,
    },
    {
      label: 'project username all',
      setup: async ({ tx }) => {
        await insertFixtureProjects(tx);
      },
      run: (tx) =>
        tx`
          INSERT INTO public.activitypub_actors (
            project_id,
            kind,
            preferred_username,
            display_name,
            enabled,
            public_key_pem,
            encrypted_private_key
          )
          VALUES (
            ${fixtureProjectId}::uuid,
            'project',
            'all',
            'bad',
            true,
            'pem',
            ${tx.json({ version: 1 } as never)}
          )
        `,
    },
  ];

  for (const testCase of cases) {
    await runRollbackTransaction(sql, async ({ tx, repository }) => {
      if (testCase.setup) {
        await testCase.setup({ tx, repository });
      }
      await assert.rejects(
        () => testCase.run(tx),
        /duplicate key|check constraint|violates/i,
        testCase.label,
      );
    });
  }
}
