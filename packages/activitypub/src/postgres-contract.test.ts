import assert from 'node:assert/strict';
import test from 'node:test';
import { createFedifyOutboxMessageFixture } from './fedify-message-fixture.ts';
import {
  claimOnePostgresQueueMessage,
  createPostgresQueueAdapter,
  processOneQueuedMessage,
  processOneQueuedOutboxMessage,
} from './postgres.ts';
import {
  parsePinnedOutboxMessage,
  redactFedifyQueueMessageForStorage,
  UnsupportedFedifyQueueMessageError,
} from './queue.ts';
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

function createStoredOutboxMessage() {
  return redactFedifyQueueMessageForStorage(createValidOutboxMessage());
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

const testRemoteActorResolver = {
  resolve: async () => ({
    actorUri: 'https://remote.example/users/alice',
    inboxUri: remoteInbox,
    sharedInboxUri: null,
  }),
};

test('processOneQueuedMessage rejects testRemoteActorResolver when ACTIVITYPUB_RUN_DB_TESTS is unset', async () => {
  const previous = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  delete process.env.ACTIVITYPUB_RUN_DB_TESTS;

  const { fakeSql, wasTouched } = createFakeSql();

  try {
    await assert.rejects(
      () =>
        processOneQueuedMessage({
          sql: fakeSql,
          canonicalOrigin,
          encryptionKey: Buffer.alloc(32, 1),
          actorRepository: { findRemotelyVisibleActorByUsername: async () => undefined } as never,
          testRemoteActorResolver,
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

test('processOneQueuedMessage rejects testRemoteActorResolver in production even when ACTIVITYPUB_RUN_DB_TESTS=1', async () => {
  const previousDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousNodeEnv = process.env.NODE_ENV;

  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  process.env.NODE_ENV = 'production';

  const { fakeSql, wasTouched } = createFakeSql();

  try {
    await assert.rejects(
      () =>
        processOneQueuedMessage({
          sql: fakeSql,
          canonicalOrigin,
          encryptionKey: Buffer.alloc(32, 1),
          actorRepository: { findRemotelyVisibleActorByUsername: async () => undefined } as never,
          testRemoteActorResolver,
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

test('claimOnePostgresQueueMessage inspects next due row without leasing and rejects malformed JSON', async () => {
  const stored = createStoredOutboxMessage();
  const inspectSql = Object.assign(
    async () => [
      {
        id: 'queue-row-1',
        dedupe_key: `${activityId}|${remoteInbox}`,
        message_json: stored,
        ordering_key: orderingKey,
        worker_token: null,
        queue_kind: 'outbox',
      },
    ],
    { json: (value: unknown) => value },
  ) as never;

  const inspected = await claimOnePostgresQueueMessage({ sql: inspectSql });
  assert.equal(inspected?.type, 'outbox');
  if (inspected?.type === 'outbox') {
    assert.equal(inspected.activityId, activityId);
    assert.equal(inspected.inbox, remoteInbox);
  }

  const malformedSql = Object.assign(
    async () => [
      {
        id: 'queue-row-2',
        dedupe_key: 'malformed|row',
        message_json: { type: 'unsupported-fedify-opaque' },
        ordering_key: orderingKey,
        worker_token: null,
        queue_kind: 'outbox',
      },
    ],
    { json: (value: unknown) => value },
  ) as never;

  await assert.rejects(
    () => claimOnePostgresQueueMessage({ sql: malformedSql }),
    UnsupportedFedifyQueueMessageError,
  );
});

test('processOneQueuedOutboxMessage rethrows original delivery error when finalizeQueueFailure fails', async () => {
  const previousDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';

  const stored = createStoredOutboxMessage();
  const workerToken = '10000000-0000-0000-0000-000000000001';
  const originalError = new Error('test actor key not found');

  const fakeSql = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('last_error_code')) {
        throw new Error('finalize failed');
      }
      if (query.includes('SELECT id, dedupe_key, message_json')) {
        return [
          {
            id: 'queue-row-1',
            dedupe_key: `${activityId}|${remoteInbox}`,
            message_json: stored,
            ordering_key: orderingKey,
            worker_token: workerToken,
            attempt_count: 0,
          },
        ];
      }
      if (
        query.includes('UPDATE public.activitypub_queue_messages') &&
        query.includes("'running'")
      ) {
        return [{ id: 'queue-row-1', attempt_count: 1 }];
      }
      return [];
    },
    {
      json: (value: unknown) => value,
      begin: async (callback: (transaction: never) => Promise<unknown>) =>
        callback(fakeSql as never),
      unsafe: async () => {
        throw originalError;
      },
    },
  ) as never;

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
        assert.equal(error, originalError);
        return true;
      },
    );
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDbTests);
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

test('parsePinnedOutboxMessage accepts HTTP actorIds alongside HTTP outbox fields', () => {
  const httpOrigin = 'http://localhost:3000';
  const parsed = parsePinnedOutboxMessage(
    {
      type: 'outbox',
      id: 'outbox-http-actorids',
      baseUrl: httpOrigin,
      keys: [{ keyId: `${httpOrigin}/activitypub/actors/pufu#main-key` }],
      activity: { id: `${httpOrigin}/activitypub/activities/create/report-1` },
      activityId: `${httpOrigin}/activitypub/activities/create/report-1`,
      activityType: 'Create',
      inbox: 'http://localhost:4000/inbox',
      sharedInbox: false,
      actorIds: [`${httpOrigin}/activitypub/actors/pufu`],
      started: '2026-08-01T00:00:00.000Z',
      attempt: 0,
      headers: {},
      orderingKey: `${httpOrigin}/activitypub/reports/report-1`,
      traceContext: {},
    },
    { requirePrivateKeys: false },
  );
  assert.equal(parsed.actorIds?.[0], `${httpOrigin}/activitypub/actors/pufu`);
});

test('processOneQueuedMessage rejects tampered outbox actorIds before private key import', async () => {
  const tampered = redactFedifyQueueMessageForStorage({
    ...createValidOutboxMessage(),
    actorIds: [`${canonicalOrigin}/activitypub/actors/other-actor`],
  });
  let importCalled = false;
  const workerToken = '10000000-0000-0000-0000-000000000002';
  const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('SELECT id, dedupe_key, message_json')) {
      return [
        {
          id: 'queue-row-outbox-tamper',
          dedupe_key: `${activityId}|${remoteInbox}`,
          message_json: tampered,
          ordering_key: orderingKey,
          worker_token: workerToken,
          queue_kind: 'outbox',
          attempt_count: 0,
        },
      ];
    }
    if (query.includes('UPDATE public.activitypub_queue_messages') && query.includes("'running'")) {
      return [{ id: 'queue-row-outbox-tamper', attempt_count: 1 }];
    }
    return [];
  };
  const fakeSql = Object.assign(queryHandler, {
    json: (value: unknown) => value,
    begin: async (callback: (tx: typeof fakeSql) => Promise<unknown>) => callback(fakeSql),
  }) as never;

  const actorRepository = {
    ensureAggregateActor: async () => undefined,
    findRemotelyVisibleActorByUsername: async () => ({
      id: '10000000-0000-0000-0000-000000000003',
      preferredUsername: 'pufu',
      enabled: true,
      kind: 'aggregate',
      projectId: null,
      inboxUri: null,
      outboxUri: null,
      followersUri: null,
      followingUri: null,
      publicKeyId: testKeyId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    importActorCryptoKeyPair: async () => {
      importCalled = true;
      throw new Error('private key import should not run');
    },
  } as never;

  await assert.rejects(
    () =>
      processOneQueuedMessage({
        sql: fakeSql,
        canonicalOrigin,
        encryptionKey: Buffer.alloc(32, 1),
        actorRepository,
      }),
    /actor binding rejected/,
  );
  assert.equal(importCalled, false);
});
