import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { exportJwk, verifyRequestDetailed } from '@fedify/fedify';
import { type DocumentLoader, exportSpki, getDocumentLoader } from '@fedify/vocab-runtime';
import postgres from 'postgres';
import { createPostgresActivityPubRepository } from './actor-repository.ts';
import { createPostgresQueueAdapter, processOneQueuedMessage } from './postgres.ts';
import { buildOutboxDedupeKey } from './queue.ts';
import { dedupeRecipients, reconstructReportDeliveryRecipients } from './report-delivery.ts';
import { buildCreateActivityJsonLd } from './report-materialization.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping signed report delivery DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for signed report delivery DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const encryptionKey = Buffer.alloc(32, 55);
const canonicalOrigin = 'https://lens.test';
const fixtureProjectId = '4f000000-0000-0000-0000-00000000db51';
const fixtureProjectSlug = 'activitypub-signed-report-fixture';
const reportId = '4f000000-0000-0000-0000-00000000db52';
let seededLocalActorId = '';
let seededKeyId = '';
let seededPublicKeyPem = '';

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixture(sql);
    await seedFixture(sql);
    await assertSignedCreateIncludesObjectAudience(sql);
    await assertSharedInboxDedupesRecipients(sql);
    console.log('activitypub signed report delivery DB tests passed');
  } finally {
    await cleanupFixture(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanupFixture(sql: postgres.Sql) {
  await sql`DELETE FROM public.activitypub_queue_messages WHERE dedupe_key LIKE ${`${canonicalOrigin}%`}`;
  if (seededLocalActorId) {
    await sql`DELETE FROM public.activitypub_follows WHERE local_actor_id = ${seededLocalActorId}::uuid`;
    await sql`DELETE FROM public.activitypub_actors WHERE id = ${seededLocalActorId}::uuid`;
  }
  await sql`DELETE FROM public.projects WHERE id = ${fixtureProjectId}::uuid`;
  seededLocalActorId = '';
  seededKeyId = '';
}

async function seedFixture(sql: postgres.Sql) {
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixtureProjectId}::uuid,
      ${fixtureProjectSlug},
      'Signed Report Fixture',
      'graph_activitypub_signed_report_fixture',
      ${fixtureProjectSlug},
      'public'
    )
  `;
  const actor = await actorRepository.enableProjectActor({
    projectId: fixtureProjectId,
    projectSlug: fixtureProjectSlug,
  });
  seededLocalActorId = actor.id;
  seededKeyId = `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`;
  const keyPair = await actorRepository.importActorCryptoKeyPair(actor.id);
  seededPublicKeyPem = await exportSpki(keyPair.publicKey);
}

async function assertSignedCreateIncludesObjectAudience(sql: postgres.Sql) {
  const fixture = await startFixtureServer();
  try {
    const activityUri = `${canonicalOrigin}/activitypub/activities/create/${encodeURIComponent(reportId)}`;
    const activity = buildCreateActivityJsonLd({
      canonicalOrigin,
      reportId,
      projectSlug: fixtureProjectSlug,
      title: 'Signed Report',
      publicSummary: 'public summary',
      publishedAt: new Date('2026-01-15T12:00:00.000Z'),
      objectRepresentation: 'article',
      projectPreferredUsername: fixtureProjectSlug,
      aggregatePreferredUsername: 'pufu',
      activityUri,
    });
    const object = activity.object as Record<string, unknown>;
    assert.deepEqual(object.to, ['https://www.w3.org/ns/activitystreams#Public']);
    assert.deepEqual(object.cc, [
      `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}/followers`,
    ]);
    await enqueueCreate(sql, fixture.inboxUrl, activityUri, activity, false);
    const received = await deliverOnce(sql, fixture);
    assert.ok(received.body.length > 0, 'signed POST body must be captured');
    await assertSignedRequest(received, fixture.inboxUrl);
    assert.match(received.body, /public summary/);
    assert.doesNotMatch(received.body, /"d":/);
    const stored = await sql<{ message_json: string }[]>`
      SELECT message_json::text AS message_json
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${buildOutboxDedupeKey({ activityId: activityUri, recipientInbox: fixture.inboxUrl })}
    `;
    assert.doesNotMatch(stored[0]?.message_json ?? '', /"d":/);
  } finally {
    await fixture.close();
  }
}

async function assertSharedInboxDedupesRecipients(_sql: postgres.Sql) {
  const publicationAt = new Date('2026-01-15T12:00:00.000Z');
  const objectUri = `${canonicalOrigin}/activitypub/reports/${encodeURIComponent(reportId)}`;
  const createActivityUri = `${canonicalOrigin}/activitypub/activities/create/${encodeURIComponent(reportId)}`;
  const announceActivityUri = `${canonicalOrigin}/activitypub/activities/announce/${encodeURIComponent(reportId)}`;
  const recipients = dedupeRecipients(
    reconstructReportDeliveryRecipients({
      publicationOccurredAt: publicationAt,
      projectActorId: seededLocalActorId,
      aggregateActorId: seededLocalActorId,
      createActivityUri,
      announceActivityUri,
      objectUri,
      projectFollowers: [
        {
          remoteActorUri: 'https://remote.example/users/alice',
          remoteInboxUri: 'https://remote.example/users/alice/inbox',
          remoteSharedInboxUri: 'https://remote.example/inbox',
          acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
          undoneAt: null,
        },
      ],
      aggregateFollowers: [
        {
          remoteActorUri: 'https://remote.example/users/alice',
          remoteInboxUri: 'https://remote.example/users/alice/inbox',
          remoteSharedInboxUri: 'https://remote.example/inbox',
          acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
          undoneAt: null,
        },
      ],
    }),
  );
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0]?.sharedInbox, true);
}

async function enqueueCreate(
  sql: postgres.Sql,
  inboxUrl: string,
  activityUri: string,
  activity: Record<string, unknown>,
  sharedInbox: boolean,
) {
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const keyPair = await actorRepository.importActorCryptoKeyPair(seededLocalActorId);
  const privateJwk = await exportJwk(keyPair.privateKey);
  const queue = createPostgresQueueAdapter({ sql, canonicalOrigin });
  await queue.enqueue(
    {
      type: 'outbox',
      id: randomUUID(),
      baseUrl: canonicalOrigin,
      keys: [{ keyId: seededKeyId, privateKey: privateJwk }],
      activity,
      activityId: activityUri,
      activityType: 'Create',
      inbox: inboxUrl,
      sharedInbox,
      actorIds: [`${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`],
      started: new Date().toISOString(),
      attempt: 0,
      headers: {},
      orderingKey: `${canonicalOrigin}/activitypub/reports/${reportId}`,
      traceContext: {},
    },
    {
      dedupeKey: buildOutboxDedupeKey({ activityId: activityUri, recipientInbox: inboxUrl }),
      orderingKey: `${canonicalOrigin}/activitypub/reports/${reportId}`,
    },
  );
}

async function deliverOnce(
  sql: postgres.Sql,
  fixture: { inboxUrl: string; server: ReturnType<typeof createServer> },
): Promise<{ headers: IncomingHttpHeaders; body: string; request: IncomingMessage }> {
  let receivedRequest: IncomingMessage | null = null;
  let receivedHeaders: IncomingHttpHeaders = {};
  let receivedBody = '';
  let resolveReceived: (() => void) | undefined;
  const receivedPromise = new Promise<void>((resolve) => {
    resolveReceived = resolve;
  });
  fixture.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    receivedRequest = request;
    receivedHeaders = request.headers;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8');
      response.statusCode = 202;
      response.end('accepted');
      resolveReceived?.();
    });
  });
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const result = await processOneQueuedMessage({
    sql,
    canonicalOrigin,
    encryptionKey,
    actorRepository,
    testOnlyAllowPrivateAddress: true,
    preferredQueueKind: 'outbox',
  });
  await receivedPromise;
  assert.equal(result.status, 'processed');
  assert.ok(receivedRequest, 'fixture server must receive signed POST');
  return { headers: receivedHeaders, body: receivedBody, request: receivedRequest };
}

async function assertSignedRequest(
  input: { headers: IncomingHttpHeaders; body: string; request: IncomingMessage },
  inboxUrl: string,
) {
  assert.ok(input.headers.signature);
  const verification = await verifyRequestDetailed(
    buildReceivedRequest(input.request, inboxUrl, input.body),
    {
      documentLoader: createActorDocumentLoader(),
      contextLoader: getDocumentLoader({ allowPrivateAddress: true, maxRedirection: 5 }),
      timeWindow: false,
    },
  );
  assert.equal(
    verification.verified,
    true,
    verification.verified
      ? undefined
      : `signature verification failed: ${JSON.stringify(verification.reason)}`,
  );
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

function createActorDocumentLoader(): DocumentLoader {
  return async (url) => ({
    contextUrl: null,
    documentUrl: url.toString(),
    document: {
      '@context': 'https://w3id.org/security/v1',
      id: seededKeyId,
      type: 'CryptographicKey',
      owner: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
      publicKeyPem: seededPublicKeyPem,
    },
  });
}

async function startFixtureServer(): Promise<{
  inboxUrl: string;
  server: ReturnType<typeof createServer>;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fixture server failed to bind');
  }
  return {
    inboxUrl: `http://127.0.0.1:${address.port}/inbox`,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
