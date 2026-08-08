import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFedifyFanoutMessageFixture,
  createFedifyInboxMessageFixture,
  createFedifyOutboxMessageFixture,
} from './fedify-message-fixture.ts';
import {
  buildOutboxDedupeKey,
  claimOneQueueMessage,
  createInMemoryQueueAdapter,
  createWebFederationWithoutQueueConsumer,
  parseStoredQueueMessage,
  redactFedifyQueueMessageForStorage,
  UnsupportedFedifyQueueMessageError,
} from './queue.ts';

const canonicalOrigin = 'https://lens.test';
const activityId = `${canonicalOrigin}/activitypub/activities/create/report-1`;
const recipientInbox = 'https://remote.example/users/alice/inbox';
const orderingKey = `${canonicalOrigin}/activitypub/reports/report-1`;
const testKeyId = `${canonicalOrigin}/activitypub/actors/pufu#main-key`;

const fixturePrivateKey: JsonWebKey = {
  kty: 'RSA',
  n: 'public-modulus',
  e: 'AQAB',
  d: 'secret-exponent',
  p: 'secret-prime-p',
  q: 'secret-prime-q',
};

const outboxMessage = createFedifyOutboxMessageFixture({
  baseUrl: canonicalOrigin,
  inbox: recipientInbox,
  activityId,
  orderingKey,
  keys: [{ keyId: testKeyId, privateKey: fixturePrivateKey }],
});

test('custom queue adapter advertises nativeRetrial=true', async () => {
  const queue = createInMemoryQueueAdapter();
  assert.equal(queue.nativeRetrial, true);
});

test('buildOutboxDedupeKey is deterministic from activity id and recipient inbox', () => {
  const first = buildOutboxDedupeKey({
    activityId,
    recipientInbox,
  });
  const second = buildOutboxDedupeKey({
    activityId,
    recipientInbox,
  });
  assert.equal(first, second);
  assert.match(first, /create\/report-1/);
  assert.match(first, /remote\.example/);
});

test('redactFedifyQueueMessageForStorage removes private JWK members but keeps key ids', () => {
  const stored = redactFedifyQueueMessageForStorage(outboxMessage);
  assert.equal(stored.type, 'outbox');
  if (stored.type !== 'outbox') {
    return;
  }

  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /secret-exponent/);
  assert.doesNotMatch(serialized, /secret-prime-p/);
  assert.doesNotMatch(serialized, /secret-prime-q/);
  assert.doesNotMatch(serialized, /"d":/);
  assert.doesNotMatch(serialized, /"p":/);
  assert.doesNotMatch(serialized, /"q":/);
  assert.match(serialized, /#main-key/);
  assert.equal(stored.activityId, activityId);
  assert.equal(stored.inbox, recipientInbox);
  assert.equal(stored.orderingKey, orderingKey);
  assert.deepEqual(stored.activity, outboxMessage.activity);
  for (const key of outboxMessage.keys) {
    assert.match(serialized, new RegExp(key.keyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('parseStoredQueueMessage rejects unsupported opaque Fedify messages', () => {
  assert.throws(
    () =>
      parseStoredQueueMessage({
        type: 'unsupported-fedify-opaque',
      }),
    UnsupportedFedifyQueueMessageError,
  );
  assert.throws(
    () =>
      parseStoredQueueMessage(
        createFedifyFanoutMessageFixture({
          baseUrl: canonicalOrigin,
          activityId,
          inbox: recipientInbox,
          keys: [{ keyId: testKeyId, privateKey: fixturePrivateKey }],
        }),
      ),
    UnsupportedFedifyQueueMessageError,
  );
  const inboxStored = parseStoredQueueMessage(
    createFedifyInboxMessageFixture({
      baseUrl: canonicalOrigin,
      activity: outboxMessage.activity,
    }),
  );
  assert.equal(inboxStored.type, 'inbox');
  assert.throws(
    () =>
      parseStoredQueueMessage({
        type: 'outbox',
      }),
    UnsupportedFedifyQueueMessageError,
  );
  assert.throws(
    () =>
      parseStoredQueueMessage({
        ...outboxMessage,
        inbox: undefined,
      }),
    UnsupportedFedifyQueueMessageError,
  );
});

test('in-memory queue propagates orderingKey and supports one-shot claim/process/success', async () => {
  const processed: string[] = [];
  const queue = createInMemoryQueueAdapter({
    onProcess: async (message: { orderingKey?: string }) => {
      processed.push(message.orderingKey ?? '');
      return { success: true };
    },
  });

  await queue.enqueue(outboxMessage);

  const claimed = await claimOneQueueMessage(queue);
  assert.ok(claimed);
  assert.equal(claimed.orderingKey, orderingKey);
  assert.equal(await claimOneQueueMessage(queue), null);
  assert.deepEqual(processed, [orderingKey]);
});

test('in-memory queue propagates onProcess success:false as a deterministic failure', async () => {
  const queue = createInMemoryQueueAdapter({
    onProcess: async () => ({ success: false }),
  });

  await queue.enqueue(outboxMessage);

  await assert.rejects(
    () => claimOneQueueMessage(queue),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedFedifyQueueMessageError);
      assert.match(error.message, /onProcess reported failure/);
      return true;
    },
  );
});

test('createWebFederationWithoutQueueConsumer never starts queue listeners or processors', async () => {
  const calls: string[] = [];
  const federation = await createWebFederationWithoutQueueConsumer({
    canonicalOrigin,
    queueHooks: {
      listen: () => {
        calls.push('listen');
      },
      startQueue: () => {
        calls.push('startQueue');
      },
      processQueuedTask: () => {
        calls.push('processQueuedTask');
      },
    },
  });

  await federation.fetch(`${canonicalOrigin}/.well-known/webfinger?resource=acct:pufu@lens.test`);
  assert.deepEqual(calls, []);
});
