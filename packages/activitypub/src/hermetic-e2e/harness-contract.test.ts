import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DocumentLoader } from '@fedify/vocab-runtime';
import {
  ActivityPubTestRuntimeDisabledError,
  assertActivityPubHermeticE2eRuntime,
  assertTestDeliveryFetchTimeoutMsAllowed,
  isActivityPubHermeticE2eRuntimeEnabled,
} from '../test-runtime-guard.ts';
import { tryHandleHermeticControlRoute } from './control-routes.ts';
import { applyHermeticFault, HermeticFaultController } from './fault-controller.ts';
import {
  createHermeticContextLoader,
  createHermeticDocumentLoader,
  createHostRouter,
} from './host-router.ts';
import { MastodonHermeticFixture, normalizeMastodonTimelineItem } from './mastodon-fixture.ts';
import {
  PROTOCOL_TRACE_PUBLIC_AUDIENCE_URI,
  ProtocolTraceCollector,
  REDACTED_METHOD,
} from './protocol-trace.ts';
import {
  assertSafeTempDatabaseName,
  removeTemplateDatabaseAlterStatement,
} from './temp-databases.ts';

const runHermetic = isActivityPubHermeticE2eRuntimeEnabled();
const fixtureDirectory = resolve(
  fileURLToPath(new URL('../../fixtures/mastodon-v4.6.5/', import.meta.url)),
);

test('assertActivityPubHermeticE2eRuntime requires hermetic env flags', () => {
  const previousDb = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousHermetic = process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  process.env.ACTIVITYPUB_RUN_HERMETIC_E2E = '1';
  process.env.NODE_ENV = 'test';
  try {
    assertActivityPubHermeticE2eRuntime();
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDb);
    restoreEnv('ACTIVITYPUB_RUN_HERMETIC_E2E', previousHermetic);
    restoreEnv('NODE_ENV', previousNodeEnv);
  }
});

test('assertActivityPubHermeticE2eRuntime rejects missing hermetic flag', () => {
  const previousDb = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousHermetic = process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  delete process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  process.env.NODE_ENV = 'test';
  try {
    assert.throws(
      () => assertActivityPubHermeticE2eRuntime(),
      (error: unknown) => error instanceof ActivityPubTestRuntimeDisabledError,
    );
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDb);
    restoreEnv('ACTIVITYPUB_RUN_HERMETIC_E2E', previousHermetic);
    restoreEnv('NODE_ENV', previousNodeEnv);
  }
});

test('assertTestDeliveryFetchTimeoutMsAllowed rejects non-positive timeout outside hermetic runtime', () => {
  const previousHermetic = process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  delete process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  try {
    assert.throws(
      () => assertTestDeliveryFetchTimeoutMsAllowed(1000),
      (error: unknown) => error instanceof ActivityPubTestRuntimeDisabledError,
    );
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_HERMETIC_E2E', previousHermetic);
  }
});

test('assertSafeTempDatabaseName accepts hermetic prefix and rejects unsafe names', () => {
  assertSafeTempDatabaseName('pufu_ap_e2e_a_test');
  assert.throws(() => assertSafeTempDatabaseName('pufu_lens'));
});

test('host router blocks unknown hosts when installed', { skip: !runHermetic }, async () => {
  const router = createHostRouter();
  const restore = router.install({
    faultController: { resolveFault: () => null } as never,
    trace: { record: () => undefined } as never,
  });
  try {
    await assert.rejects(() => fetch('https://evil.example/'), /blocked external host/i);
  } finally {
    restore();
  }
});

test('Mastodon v4.6.5 provenance pins the audited commit and official contracts', async () => {
  const provenance = JSON.parse(
    await readFile(resolve(fixtureDirectory, 'provenance.json'), 'utf8'),
  ) as {
    mastodonVersion?: string;
    mastodonCommit?: string;
    contracts?: Array<{ sourceUrl?: string }>;
    residualRisk?: string;
  };
  assert.equal(provenance.mastodonVersion, 'v4.6.5');
  assert.equal(provenance.mastodonCommit, '1440d55b139e39ec722c2a3db7f60b66cd889048');
  assert.ok(provenance.contracts?.length && provenance.contracts.length >= 5);
  assert.ok(
    provenance.contracts.every((contract) =>
      contract.sourceUrl?.includes(provenance.mastodonCommit as string),
    ),
  );
  assert.match(provenance.residualRisk ?? '', /no live Mastodon server/i);
});

test('golden Create and Announce payloads normalize to the pinned timeline projection', async () => {
  const createText = await readFile(
    resolve(fixtureDirectory, 'golden-create-article.json'),
    'utf8',
  );
  const announceText = await readFile(
    resolve(fixtureDirectory, 'golden-announce-article.json'),
    'utf8',
  );
  const create = JSON.parse(createText) as { object: Record<string, unknown> };
  let loaderCalledWith: string | undefined;
  const loader: DocumentLoader = async (url) => {
    loaderCalledWith = url;
    return {
      contextUrl: null,
      documentUrl: url,
      document: create.object,
    };
  };
  const createItem = await normalizeMastodonTimelineItem(
    createText,
    'Create',
    'https://lens-a.test/activitypub/activities/create/synthetic-report',
  );
  const announceItem = await normalizeMastodonTimelineItem(
    announceText,
    'Announce',
    'https://lens-a.test/activitypub/activities/announce/synthetic-report',
    loader,
  );
  assert.equal(loaderCalledWith, 'https://lens-a.test/activitypub/reports/synthetic-report');
  for (const item of [createItem, announceItem]) {
    assert.equal(item?.title, 'Synthetic Hermetic Report');
    assert.equal(item?.summary, 'Synthetic public summary for fixture validation.');
    assert.equal(item?.reportUrl, 'https://lens-a.test/reports/public/project-a/synthetic-report');
  }
});

test('isActivityPubHermeticE2eRuntimeEnabled requires all hermetic env flags', () => {
  const previousDb = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousHermetic = process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  process.env.ACTIVITYPUB_RUN_HERMETIC_E2E = '1';
  process.env.NODE_ENV = 'test';
  try {
    assert.equal(isActivityPubHermeticE2eRuntimeEnabled(), true);
    delete process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
    assert.equal(isActivityPubHermeticE2eRuntimeEnabled(), false);
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDb);
    restoreEnv('ACTIVITYPUB_RUN_HERMETIC_E2E', previousHermetic);
    restoreEnv('NODE_ENV', previousNodeEnv);
  }
});

test('hermetic context loader resolves pinned preloaded contexts and rejects near-miss URLs', {
  skip: !runHermetic,
}, async () => {
  const loader = createHermeticContextLoader();
  const activityStreams = await loader('https://www.w3.org/ns/activitystreams');
  assert.ok(activityStreams.document);
  const security = await loader('https://w3id.org/security/v1');
  assert.ok(security.document);
  const did = await loader('https://www.w3.org/ns/did/v1');
  assert.ok(did.document);
  const multikey = await loader('https://w3id.org/security/multikey/v1');
  assert.ok(multikey.document);
  const gotosocial = await loader('https://gotosocial.org/ns');
  assert.ok(gotosocial.document);
  await assert.rejects(
    () => loader('https://evil.example/context.jsonld'),
    /rejected external context/i,
  );
  await assert.rejects(
    () => loader('https://www.w3.org/evil-context'),
    /rejected external context/i,
  );
  await assert.rejects(() => loader('https://w3id.org/evil-context'), /rejected external context/i);
});

test('hermetic document loader rejects external documents outside allowlisted hosts', {
  skip: !runHermetic,
}, async () => {
  const loader = createHermeticDocumentLoader(
    async () => new Response('not found', { status: 404 }),
  );
  await assert.rejects(
    () => loader('https://evil.example/users/alice'),
    /rejected external document/i,
  );
});

test('removeTemplateDatabaseAlterStatement strips the template database search_path ALTER', () => {
  const input = `
CREATE EXTENSION IF NOT EXISTS age;
ALTER DATABASE pufu_lens SET search_path = ag_catalog, "$user", public;
SET search_path = ag_catalog, "$user", public;
`;
  const output = removeTemplateDatabaseAlterStatement(input);
  assert.match(output, /SET search_path = ag_catalog/);
  assert.doesNotMatch(output, /ALTER\s+DATABASE\s+pufu_lens/i);
});

test('ProtocolTraceCollector redacts PII-like metadata from every string field', () => {
  const trace = new ProtocolTraceCollector('/tmp/protocol-trace-redaction-test.json');
  const piiEmail = 'alice.secret@example.test';
  const piiUser = '70000000-0000-0000-0000-00000000000a';
  trace.record({
    method: `POST-${piiUser}`,
    host: 'evil.example',
    path: `/private/${piiUser}/details`,
    status: 202,
    activityType: 'CustomType',
    activityId: `https://evil.example/activities/${piiUser}`,
    signed: true,
    digestKind: 'rfc9421',
    signatureVerified: true,
    keyOwnerUri: `https://lens-a.test/activitypub/actors/${piiUser}`,
    audienceUri: piiEmail,
  });
  const serialized = JSON.stringify(trace.snapshot());
  assert.doesNotMatch(serialized, new RegExp(piiEmail.replace('.', '\\.')));
  assert.doesNotMatch(serialized, /70000000-0000-0000-0000-00000000000a/);
  assert.equal(trace.snapshot()[0]?.host, '[redacted-host]');
  assert.equal(trace.snapshot()[0]?.path, '[redacted-path]');
  assert.equal(trace.snapshot()[0]?.activityType, '[redacted-type]');
  assert.equal(trace.snapshot()[0]?.method, REDACTED_METHOD);
  assert.equal(trace.snapshot()[0]?.digestKind, 'rfc9421');
  trace.record({
    method: 'POST',
    host: 'mastodon.test',
    path: '/inbox',
    status: 202,
    signed: true,
    digestKind: 'none',
    audienceUri: PROTOCOL_TRACE_PUBLIC_AUDIENCE_URI,
  });
  assert.equal(trace.snapshot()[1]?.audienceUri, PROTOCOL_TRACE_PUBLIC_AUDIENCE_URI);
});

test('HermeticFaultController prefers the longest matching pathPrefix', () => {
  const controller = new HermeticFaultController();
  controller.setFault({ host: 'lens-b.test', pathPrefix: '/activitypub' }, 'http_503');
  controller.setFault({ host: 'lens-b.test', pathPrefix: '/activitypub/inbox' }, 'timeout');
  const fault = controller.resolveFault(new URL('https://lens-b.test/activitypub/inbox'), 'POST');
  assert.equal(fault, 'timeout');
});

test('applyHermeticFault timeout rejects when abort never fires', async () => {
  const controller = new AbortController();
  await assert.rejects(
    () => applyHermeticFault('timeout', async () => new Response('ok'), controller.signal),
    /timed out/i,
  );
});

test('Mastodon WebFinger accepts known users on mastodon.test only', {
  skip: !runHermetic,
}, async () => {
  const trace = new ProtocolTraceCollector('/tmp/mastodon-webfinger-test.json');
  const fixture = await MastodonHermeticFixture.create(trace, async (url) => ({
    contextUrl: null,
    documentUrl: url,
    document: {},
  }));
  const valid = await fixture.handleRequest(
    new Request('https://mastodon.test/.well-known/webfinger?resource=acct:alice@mastodon.test'),
  );
  assert.equal(valid.status, 200);
  const wrongDomain = await fixture.handleRequest(
    new Request('https://mastodon.test/.well-known/webfinger?resource=acct:alice@evil.test'),
  );
  assert.equal(wrongDomain.status, 404);
  const unknownUser = await fixture.handleRequest(
    new Request('https://mastodon.test/.well-known/webfinger?resource=acct:unknown@mastodon.test'),
  );
  assert.equal(unknownUser.status, 404);
});

test('hermetic control routes reject malformed JSON and invalid limits', {
  skip: !runHermetic,
}, async () => {
  const ctx = {
    label: 'a' as const,
    origin: 'https://lens-a.test',
    sql: {} as never,
    actorRepository: {} as never,
    followUseCases: {} as never,
    projectId: '70000000-0000-0000-0000-00000000000a',
    projectSlug: 'project-a',
    reportId: '70000000-0000-0000-0000-0000000000a1',
    faultController: new HermeticFaultController(),
    drainQueue: async () => ({ processed: 0, failed: 0 }),
    runDispatcher: async () => ({ materialized: 0, processed: 0 }),
  };
  const malformed = await tryHandleHermeticControlRoute(
    new Request('https://lens-a.test/__hermetic__/process-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
    ctx,
  );
  assert.equal(malformed?.status, 400);
  const invalidLimit = await tryHandleHermeticControlRoute(
    new Request('https://lens-a.test/__hermetic__/process-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 0 }),
    }),
    ctx,
  );
  assert.equal(invalidLimit?.status, 400);
});

test('applyHermeticFault accept_then_fail rejects non-POST requests via resolveFault', () => {
  const controller = new HermeticFaultController();
  controller.setFault({ host: 'lens-b.test', pathPrefix: '/inbox' }, 'accept_then_fail');
  assert.equal(controller.resolveFault(new URL('https://lens-b.test/inbox'), 'GET'), null);
});

function restoreEnv(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
