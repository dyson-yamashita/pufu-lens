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
} from '../test-runtime-guard.ts';
import { createHostRouter } from './host-router.ts';
import { normalizeMastodonTimelineItem } from './mastodon-fixture.ts';
import { assertSafeTempDatabaseName } from './temp-databases.ts';

const runHermetic = process.env.ACTIVITYPUB_RUN_HERMETIC_E2E === '1';
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
  const loader: DocumentLoader = async (url) => ({
    contextUrl: null,
    documentUrl: url,
    document: create.object,
  });
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
  for (const item of [createItem, announceItem]) {
    assert.equal(item?.title, 'Synthetic Hermetic Report');
    assert.equal(item?.summary, 'Synthetic public summary for fixture validation.');
    assert.equal(item?.reportUrl, 'https://lens-a.test/reports/public/project-a/synthetic-report');
  }
});

function restoreEnv(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
