import assert from 'node:assert/strict';
import test from 'node:test';
import { createFedifyOutboxMessageFixture } from './fedify-message-fixture.ts';
import { createPostgresQueueAdapter, processOneQueuedOutboxMessage } from './postgres.ts';
import { UnsupportedFedifyQueueMessageError } from './queue.ts';
import { ActivityPubTestRuntimeDisabledError } from './test-runtime-guard.ts';

const canonicalOrigin = 'https://lens.test';
const remoteInbox = 'https://remote.example/users/alice/inbox';
const activityId = `${canonicalOrigin}/activitypub/activities/create/report-1`;
const orderingKey = `${canonicalOrigin}/activitypub/reports/report-1`;
const testKeyId = `${canonicalOrigin}/activitypub/actors/pufu#main-key`;
const evilOrigin = 'https://evil.example';

const fixturePrivateKey: JsonWebKey = {
  kty: 'RSA',
  n: 'public-modulus',
  e: 'AQAB',
  d: 'secret-exponent',
  p: 'secret-prime-p',
  q: 'secret-prime-q',
};

function createValidOutboxMessage() {
  return createFedifyOutboxMessageFixture({
    baseUrl: canonicalOrigin,
    inbox: remoteInbox,
    activityId,
    orderingKey,
    keys: [{ keyId: testKeyId, privateKey: fixturePrivateKey }],
  });
}

function createFakeSql() {
  let touched = false;
  const fakeSql = Object.assign(
    async () => {
      touched = true;
      return [];
    },
    {
      json: (value: unknown) => value,
    },
  );
  return {
    fakeSql: fakeSql as never,
    wasTouched: () => touched,
  };
}

function restoreEnv(name: 'ACTIVITYPUB_RUN_DB_TESTS' | 'NODE_ENV', previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

test('processOneQueuedOutboxMessage rejects before SQL when ACTIVITYPUB_RUN_DB_TESTS is unset', async () => {
  const previous = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  delete process.env.ACTIVITYPUB_RUN_DB_TESTS;

  const { fakeSql, wasTouched } = createFakeSql();

  try {
    await assert.rejects(
      () =>
        processOneQueuedOutboxMessage({
          sql: fakeSql,
          canonicalOrigin,
          actorTable: 'activitypub_contract_test_actor_keys',
          actorId: '10000000-0000-0000-0000-000000000667',
          testOnlyAllowPrivateAddress: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ActivityPubTestRuntimeDisabledError);
        return true;
      },
    );
    assert.equal(wasTouched(), false);
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previous);
  }
});

test('processOneQueuedOutboxMessage rejects in production even when ACTIVITYPUB_RUN_DB_TESTS=1', async () => {
  const previousDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousNodeEnv = process.env.NODE_ENV;

  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  process.env.NODE_ENV = 'production';

  const { fakeSql, wasTouched } = createFakeSql();

  try {
    await assert.rejects(
      () =>
        processOneQueuedOutboxMessage({
          sql: fakeSql,
          canonicalOrigin,
          actorTable: 'activitypub_contract_test_actor_keys',
          actorId: '10000000-0000-0000-0000-000000000667',
          testOnlyAllowPrivateAddress: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ActivityPubTestRuntimeDisabledError);
        return true;
      },
    );
    assert.equal(wasTouched(), false);
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDbTests);
    restoreEnv('NODE_ENV', previousNodeEnv);
  }
});

const mismatchedLocalFieldCases = [
  {
    field: 'baseUrl',
    message: createValidOutboxMessage(),
    mutate: () => ({
      ...createValidOutboxMessage(),
      baseUrl: evilOrigin,
    }),
    expectedMessage: /baseUrl origin does not match canonical origin/,
  },
  {
    field: 'activityId',
    message: createValidOutboxMessage(),
    mutate: () => ({
      ...createValidOutboxMessage(),
      activityId: `${evilOrigin}/activitypub/activities/create/report-1`,
    }),
    expectedMessage: /activityId origin does not match canonical origin/,
  },
  {
    field: 'orderingKey',
    message: createValidOutboxMessage(),
    mutate: () => ({
      ...createValidOutboxMessage(),
      orderingKey: `${evilOrigin}/activitypub/reports/report-1`,
    }),
    expectedMessage: /orderingKey origin does not match canonical origin/,
  },
  {
    field: 'keys[].keyId',
    message: createValidOutboxMessage(),
    mutate: () => ({
      ...createValidOutboxMessage(),
      keys: [
        {
          keyId: `${evilOrigin}/activitypub/actors/pufu#main-key`,
          privateKey: fixturePrivateKey,
        },
      ],
    }),
    expectedMessage: /keys\[0\]\.keyId origin does not match canonical origin/,
  },
  {
    field: 'actorIds[]',
    message: createValidOutboxMessage(),
    mutate: () => ({
      ...createValidOutboxMessage(),
      actorIds: [`${evilOrigin}/activitypub/actors/pufu`],
    }),
    expectedMessage: /actorIds\[0\] origin does not match canonical origin/,
  },
] as const;

for (const testCase of mismatchedLocalFieldCases) {
  test(`createPostgresQueueAdapter rejects ${testCase.field} outside canonical origin before SQL`, async () => {
    const { fakeSql, wasTouched } = createFakeSql();
    const queue = createPostgresQueueAdapter({
      sql: fakeSql,
      canonicalOrigin,
    });

    await assert.rejects(
      () => queue.enqueue(testCase.mutate()),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedFedifyQueueMessageError);
        assert.match(error.message, testCase.expectedMessage);
        return true;
      },
    );
    assert.equal(wasTouched(), false);
  });
}
