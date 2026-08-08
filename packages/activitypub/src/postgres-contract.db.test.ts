import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { join } from 'node:path';
import { exportJwk, generateCryptoKeyPair, verifyRequestDetailed } from '@fedify/fedify';
import { type DocumentLoader, exportSpki, getDocumentLoader } from '@fedify/vocab-runtime';
import postgres from 'postgres';
import { createFedifyOutboxMessageFixture } from './fedify-message-fixture.ts';
import {
  claimOnePostgresQueueMessage,
  createPostgresFedifyKvStore,
  createPostgresQueueAdapter,
  persistTestActorKey,
  reloadTestActorKey,
} from './postgres.ts';
import { parseStoredQueueMessage } from './queue.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping postgres contract DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for postgres contract DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;

const canonicalOrigin = 'https://lens.test';
const activityId = `${canonicalOrigin}/activitypub/activities/create/report-db-1`;
const recipientInbox = 'https://remote.example/users/alice/inbox';
const dedupeKey = `${activityId}|${recipientInbox}`;
const testActorTable = 'activitypub_contract_test_actor_keys';
const testActorId = '10000000-0000-0000-0000-000000000667';
const testKeyId = `${canonicalOrigin}/activitypub/actors/pufu#main-key`;
const orderingKey = `${canonicalOrigin}/activitypub/reports/report-db-1`;
const testKvKey = ['activitypub-contract:kv'] as const;

const { publicKey, privateKey } = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
const publicJwk = await exportJwk(publicKey);
const privateJwk = await exportJwk(privateKey);
const publicKeyPem = await exportSpki(publicKey);

await main();

async function main() {
  try {
    const setupClient = postgres(resolvedDatabaseUrl, { max: 1 });
    try {
      await resetFixture(setupClient);
      await assertResetFixtureDeletesOnlyExactActivityId(setupClient);
      await assertQueuePersistenceAndIdempotency(setupClient);
    } finally {
      await setupClient.end({ timeout: 5 });
    }

    await assertKvAndQueueSurviveClientRestart();
    await assertActorKeyReloadAfterRestart();
    await assertOneShotDispatchSignsAndDelivers();
    console.log('activitypub postgres contract DB tests passed');
  } finally {
    const cleanupClient = postgres(resolvedDatabaseUrl, { max: 1 });
    try {
      await resetFixture(cleanupClient);
    } finally {
      await cleanupClient.end({ timeout: 5 });
    }
  }
}

async function resetFixture(sql: postgres.Sql) {
  await sql.unsafe(`DROP TABLE IF EXISTS public.${testActorTable}`);
  await sql.unsafe(
    `DELETE FROM public.activitypub_queue_messages WHERE split_part(dedupe_key, '|', 1) = $1`,
    [activityId],
  );
  await sql.unsafe(
    `DELETE FROM public.activitypub_fedify_kv WHERE array_length(key, 1) = 1 AND key[1] LIKE $1`,
    ['activitypub-contract:%'],
  );
}

async function assertResetFixtureDeletesOnlyExactActivityId(sql: postgres.Sql) {
  const lookalikeOrigin = 'https://lens.test.evil';
  const lookalikeActivityId = `${lookalikeOrigin}/activitypub/activities/create/report-db-sentinel`;
  const sentinelDedupeKey = `${lookalikeActivityId}|${recipientInbox}`;
  const sentinelOrderingKey = `${lookalikeOrigin}/activitypub/reports/report-db-sentinel`;

  try {
    await sql`
      INSERT INTO public.activitypub_queue_messages (
        id,
        dedupe_key,
        queue_kind,
        ordering_key,
        recipient_origin,
        message_json,
        status,
        available_at,
        attempt_count,
        created_at,
        updated_at
      )
      VALUES (
        ${randomUUID()},
        ${sentinelDedupeKey},
        'outbox',
        ${sentinelOrderingKey},
        ${new URL(recipientInbox).origin},
        ${sql.json({ sentinel: true })},
        'pending',
        now(),
        0,
        now(),
        now()
      )
    `;

    const queue = createPostgresQueueAdapter({ sql, canonicalOrigin });
    await queue.enqueue(createOutboxMessage(recipientInbox), { dedupeKey });

    await resetFixture(sql);

    const sentinelRows = await sql<{ dedupe_key: string }[]>`
      SELECT dedupe_key
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${sentinelDedupeKey}
    `;
    assert.equal(sentinelRows.length, 1, 'lookalike-origin sentinel row must survive resetFixture');

    const canonicalRows = await sql<{ dedupe_key: string }[]>`
      SELECT dedupe_key
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(
      canonicalRows.length,
      0,
      'canonical contract activity row must be deleted by resetFixture',
    );
  } finally {
    await sql`
      DELETE FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${sentinelDedupeKey}
    `;
  }
}

function createOutboxMessage(inbox: string) {
  return createFedifyOutboxMessageFixture({
    baseUrl: canonicalOrigin,
    inbox,
    activityId,
    orderingKey,
    reportId: 'report-db-1',
    keys: [{ keyId: testKeyId, privateKey: privateJwk }],
  });
}

async function assertQueuePersistenceAndIdempotency(sql: postgres.Sql) {
  const queue = createPostgresQueueAdapter({ sql, canonicalOrigin });
  const message = createOutboxMessage(recipientInbox);

  await queue.enqueue(message, { dedupeKey });
  await queue.enqueue(message, { dedupeKey });

  const rows = await sql<{ dedupe_key: string; message_json: unknown }[]>`
    SELECT dedupe_key, message_json
    FROM public.activitypub_queue_messages
    WHERE dedupe_key = ${dedupeKey}
  `;
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows[0]?.message_json);
  assert.doesNotMatch(serialized, /"d":/);
  assert.doesNotMatch(serialized, /"p":/);
  assert.doesNotMatch(serialized, /"q":/);
  assert.match(serialized, /#main-key/);
  assert.match(serialized, /report-db-1/);
  assert.match(serialized, /create\/report-db-1/);
  const stored = parseStoredQueueMessage(rows[0]?.message_json);
  assert.equal(stored.inbox, recipientInbox);
}

async function assertKvAndQueueSurviveClientRestart() {
  const writerClient = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    const kv = createPostgresFedifyKvStore({ sql: writerClient, initialized: true });
    await kv.set(testKvKey, { persisted: true });
  } finally {
    await writerClient.end({ timeout: 5 });
  }

  const readerClient = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    const queueRows = await readerClient<{ dedupe_key: string }[]>`
      SELECT dedupe_key
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(queueRows.length, 1);

    const reopenedKv = createPostgresFedifyKvStore({ sql: readerClient, initialized: true });
    const value = await reopenedKv.get(testKvKey);
    assert.deepEqual(value, { persisted: true });

    await readerClient`
      DELETE FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
  } finally {
    await readerClient.end({ timeout: 5 });
  }
}

async function assertActorKeyReloadAfterRestart() {
  const writeClient = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await assert.rejects(
      () =>
        persistTestActorKey({
          sql: writeClient,
          tableName: 'evil;drop table',
          actorId: testActorId,
          keyId: testKeyId,
          publicJwk,
          privateJwk,
        }),
      /invalid.*table/i,
    );

    await persistTestActorKey({
      sql: writeClient,
      tableName: testActorTable,
      actorId: testActorId,
      keyId: testKeyId,
      publicJwk,
      privateJwk,
    });
  } finally {
    await writeClient.end({ timeout: 5 });
  }

  const reloadedClient = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    const reloaded = await reloadTestActorKey({
      sql: reloadedClient,
      tableName: testActorTable,
      actorId: testActorId,
    });
    assert.equal(reloaded.actorId, testActorId);
    assert.equal(reloaded.keyId, testKeyId);
    assert.equal(reloaded.publicJwk.kty, 'RSA');
    assert.equal(reloaded.privateJwk.kty, 'RSA');
    assert.ok(reloaded.publicJwk.n);
    assert.ok(reloaded.privateJwk.d);
  } finally {
    await reloadedClient.end({ timeout: 5 });
  }
}

async function assertOneShotDispatchSignsAndDelivers() {
  const fixtureServer = await startFixtureServer();
  const inboxUrl = `http://127.0.0.1:${fixtureServer.port}/inbox`;
  let receivedRequest: IncomingMessage | null = null;
  let receivedHeaders: IncomingHttpHeaders = {};
  let receivedBody = '';

  fixtureServer.server.on('request', (request, response) => {
    receivedRequest = request;
    receivedHeaders = request.headers;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8');
      response.statusCode = 202;
      response.end('accepted');
    });
  });

  try {
    const actorWriteClient = postgres(resolvedDatabaseUrl, { max: 1 });
    try {
      await persistTestActorKey({
        sql: actorWriteClient,
        tableName: testActorTable,
        actorId: testActorId,
        keyId: testKeyId,
        publicJwk,
        privateJwk,
      });
    } finally {
      await actorWriteClient.end({ timeout: 5 });
    }

    const enqueueClient = postgres(resolvedDatabaseUrl, { max: 1 });
    try {
      const queue = createPostgresQueueAdapter({ sql: enqueueClient, canonicalOrigin });
      await queue.enqueue(createOutboxMessage(inboxUrl), {
        dedupeKey: `${activityId}|${inboxUrl}`,
      });
    } finally {
      await enqueueClient.end({ timeout: 5 });
    }

    const dispatchScript = join(
      import.meta.dirname,
      '../../../scripts/activitypub-dispatch-once.ts',
    );
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        dispatchScript,
        '--database-url',
        resolvedDatabaseUrl,
        '--actor-table',
        testActorTable,
        '--actor-id',
        testActorId,
      ],
      {
        env: {
          ...process.env,
          ACTIVITYPUB_RUN_DB_TESTS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const { exitCode, stdout, stderr } = await waitForDispatchChildAndFixtureRequest({
      child,
      server: fixtureServer.server,
      timeoutMs: 15_000,
    });

    assert.equal(exitCode, 0, `dispatch child failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    const completion = parseChildCompletion(stdout, stderr);
    assert.equal(completion.processor, 'Federation.processQueuedTask');

    assert.ok(receivedRequest, 'fixture server must receive signed POST');
    const request = buildReceivedRequest(receivedRequest, inboxUrl, receivedBody);
    const contextLoader = getDocumentLoader({
      allowPrivateAddress: false,
      maxRedirection: 5,
    });
    const verification = await verifyRequestDetailed(request, {
      documentLoader: createTestActorDocumentLoader(publicKeyPem, testKeyId),
      contextLoader,
      timeWindow: false,
    });
    assert.equal(
      verification.verified,
      true,
      verification.verified
        ? undefined
        : `signature verification failed: ${JSON.stringify(verification.reason)}`,
    );
    if (verification.verified) {
      assert.equal(verification.key.id?.toString(), testKeyId);
    }

    assertSignedDeliveryIntegrityHeaders(receivedHeaders);
    assert.match(receivedBody, /report-db-1/);
    const parsedDeliveryBody = parseSignedDeliveryBody(receivedBody);
    assert.equal(parsedDeliveryBody.id, activityId);

    const claimClient = postgres(resolvedDatabaseUrl, { max: 1 });
    try {
      const claimed = await claimOnePostgresQueueMessage({ sql: claimClient });
      assert.equal(claimed, null, 'one-shot dispatch must claim exactly one message');
    } finally {
      await claimClient.end({ timeout: 5 });
    }
  } finally {
    await fixtureServer.close();
  }
}

function parseSignedDeliveryBody(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('signed delivery body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('signed delivery body must be a plain object');
  }
  return parsed as Record<string, unknown>;
}

function assertSignedDeliveryIntegrityHeaders(headers: IncomingHttpHeaders): void {
  assert.ok(headers.signature, 'signed POST must include Signature header');

  const hasLegacyDigest = Boolean(headers.digest);
  const hasContentDigest = Boolean(headers['content-digest']);
  assert.ok(
    hasLegacyDigest || hasContentDigest,
    'signed POST must include Digest or Content-Digest header',
  );
  if (hasContentDigest) {
    assert.ok(
      headers['signature-input'],
      'RFC 9421 signed delivery must include Signature-Input when Content-Digest is present',
    );
  }
}

function createTestActorDocumentLoader(actorPublicKeyPem: string, keyId: string): DocumentLoader {
  return async (url) => {
    const href = url.toString();
    if (href !== keyId) {
      throw new Error(`unexpected document url: ${href}`);
    }
    return {
      contextUrl: null,
      documentUrl: href,
      document: {
        '@context': 'https://w3id.org/security/v1',
        id: keyId,
        type: 'CryptographicKey',
        owner: `${canonicalOrigin}/activitypub/actors/pufu`,
        publicKeyPem: actorPublicKeyPem,
      },
    };
  };
}

function buildReceivedRequest(incoming: IncomingMessage, inboxUrl: string, body: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }
    headers.set(name, value);
  }

  return new Request(inboxUrl, {
    method: incoming.method ?? 'POST',
    headers,
    body,
  });
}

async function waitForDispatchChildAndFixtureRequest(input: {
  child: ChildProcess;
  server: Server;
  timeoutMs?: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  let stdout = '';
  let stderr = '';
  let requestReceived = false;
  let exitCode: number | null | undefined;

  return await new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout;

    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };
    const onRequest = () => {
      requestReceived = true;
      maybeFinish();
    };
    const onClose = (code: number | null) => {
      exitCode = code;
      maybeFinish();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout?.off('data', onStdout);
      input.child.stderr?.off('data', onStderr);
      input.child.off('close', onClose);
      input.child.off('error', onError);
      input.server.off('request', onRequest);
    };

    const maybeFinish = () => {
      if (exitCode !== undefined && requestReceived) {
        cleanup();
        resolve({ exitCode, stdout, stderr });
        return;
      }
      if (exitCode !== undefined && !requestReceived) {
        cleanup();
        reject(
          new Error(
            `dispatch child exited before fixture received request (code=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `dispatch child or fixture request timed out after ${timeoutMs}ms (exitCode=${exitCode ?? 'pending'}, requestReceived=${requestReceived})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    input.child.stdout?.on('data', onStdout);
    input.child.stderr?.on('data', onStderr);
    input.child.on('close', onClose);
    input.child.on('error', onError);
    input.server.on('request', onRequest);
  });
}

function parseChildCompletion(stdout: string, stderr: string): { processor: string } {
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { processor?: string };
      if (parsed.processor) {
        return { processor: parsed.processor };
      }
    } catch {
      // keep scanning for the completion JSON line
    }
  }

  assert.fail(
    `dispatch child did not emit completion JSON\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  return { processor: '' };
}

async function startFixtureServer(): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fixture server failed to bind');
  }

  return {
    server,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
