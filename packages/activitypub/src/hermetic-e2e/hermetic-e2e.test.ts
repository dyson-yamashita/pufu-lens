import assert from 'node:assert/strict';
import { createProductionSafeDocumentLoader } from '../security.ts';
import { isActivityPubHermeticE2eRuntimeEnabled } from '../test-runtime-guard.ts';
import {
  actorInboxFor,
  actorUriFor,
  createHermeticE2EHarness,
  drainAllQueues,
  runFollowCycle,
} from './harness.ts';
import { buildRemoteLensActorAddress } from './mastodon-fixture.ts';

const runHermetic = isActivityPubHermeticE2eRuntimeEnabled();
const databaseUrl =
  process.env.DATABASE_URL?.trim() || 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens';

if (!runHermetic) {
  console.log('Skipping hermetic ActivityPub E2E (run via pnpm test:activitypub:e2e)');
  process.exit(0);
}

await main();

async function main() {
  const harness = await createHermeticE2EHarness(databaseUrl);
  try {
    try {
      await assertDistinctPublicKeys(harness.lensA, harness.lensB);
      await assertWebFingerAndActorFetch(harness);
      await assertRepresentationCanChangeBeforeOutbound(harness);
      await assertLensSubscriptions(harness);
      await assertMastodonFollowUndoOrdering(harness);
      await assertInvalidSignatureRejected(harness);
      await assertRepresentationLocksAfterOutbound(harness);
      await assertReportPublicationDelivery(harness);
      await assertMastodonTimelineProjection(harness);
      await assertSharedInboxTraceAndDedupe(harness);
      await assertFaultRecoveryScenarios(harness);
      await assertAcceptThenFailIsIdempotent(harness);
      await assertProductionLoaderRejectsPrivateAddresses();
      assertSanitizedProtocolTrace(harness);
      console.log('activitypub hermetic E2E passed');
    } finally {
      await harness.trace.writeArtifact();
    }
  } finally {
    await harness.close();
  }
}

async function assertDistinctPublicKeys(
  lensA: Awaited<ReturnType<typeof createHermeticE2EHarness>>['lensA'],
  lensB: Awaited<ReturnType<typeof createHermeticE2EHarness>>['lensB'],
) {
  assert.notEqual(lensA.publicKeyPem, lensB.publicKeyPem);
}

async function assertWebFingerAndActorFetch(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  for (const instance of [harness.lensA, harness.lensB]) {
    const acct = `acct:${instance.projectSlug}@${instance.host}`;
    const webfingerResponse = await fetch(
      `${instance.origin}/.well-known/webfinger?resource=${encodeURIComponent(acct)}`,
    );
    assert.equal(webfingerResponse.status, 200);
    const webfinger = (await webfingerResponse.json()) as {
      links: Array<{ rel: string; href?: string }>;
    };
    const actorHref = webfinger.links.find((link) => link.rel === 'self')?.href;
    assert.ok(actorHref);
    const actorResponse = await fetch(actorHref as string, {
      headers: { accept: 'application/activity+json' },
    });
    assert.equal(actorResponse.status, 200);
    const actor = (await actorResponse.json()) as {
      id?: string;
      publicKey?: { id?: string; owner?: string; publicKeyPem?: string };
    };
    assert.ok(actor.publicKey, `Actor key fields: ${Object.keys(actor).join(',')}`);
    assert.equal(actor.publicKey.owner, actor.id);
    assert.equal(actor.publicKey?.publicKeyPem, instance.publicKeyPem);
  }

  const crossSearch = await harness.lensA.control.search({
    acct: `acct:${harness.lensB.projectSlug}@${harness.lensB.host}`,
  });
  assert.equal(crossSearch.status, 200);
  assert.equal(
    (
      await harness.lensB.control.search({
        acct: `acct:${harness.lensA.projectSlug}@${harness.lensA.host}`,
      })
    ).status,
    200,
  );
  assert.equal(
    (await harness.lensA.control.search({ acct: 'acct:alice@mastodon.test' })).status,
    200,
  );
}

async function assertLensSubscriptions(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const scenarios = [
    { source: harness.lensA, target: harness.lensB, targetUsername: 'project-b' as const },
    { source: harness.lensB, target: harness.lensA, targetUsername: 'project-a' as const },
    { source: harness.lensA, target: harness.lensB, targetUsername: 'all' as const },
    { source: harness.lensB, target: harness.lensA, targetUsername: 'all' as const },
  ];
  for (const scenario of scenarios) {
    await runFollowCycle(scenario);
    const sourceState = await readState(scenario.source);
    const targetState = await readState(scenario.target);
    const remoteActorUri = actorUriFor(scenario.target, scenario.targetUsername);
    assert.ok(
      sourceState.follows.some(
        (follow) =>
          follow.direction === 'outbound' &&
          follow.status === 'accepted' &&
          follow.remote_actor_uri === remoteActorUri,
      ),
      `outbound subscription was not accepted: ${JSON.stringify(sourceState.follows)}`,
    );
    assert.ok(
      targetState.follows.some(
        (follow) =>
          follow.local_actor === scenario.targetUsername &&
          follow.direction === 'inbound' &&
          follow.status === 'accepted' &&
          follow.remote_actor_uri === actorUriFor(scenario.source, scenario.source.projectSlug),
      ),
      `inbound subscription was not accepted: ${JSON.stringify(targetState.follows)}`,
    );
  }
}

async function assertMastodonFollowUndoOrdering(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const projectFollowUri = 'https://mastodon.test/users/alice/activities/follow-project-a';
  await sendMastodonFollow(harness, {
    actor: 'alice',
    targetUsername: 'project-a',
    followActivityUri: projectFollowUri,
  });
  const acceptsAfterFirstFollow = harness.mastodon.recordedAccepts.length;
  await sendMastodonFollow(harness, {
    actor: 'alice',
    targetUsername: 'project-a',
    followActivityUri: projectFollowUri,
  });
  assert.equal(harness.mastodon.recordedAccepts.length, acceptsAfterFirstFollow);

  const staleFollowUri = 'https://mastodon.test/users/bob/activities/follow-all-stale';
  const targetActorUri = actorUriFor(harness.lensA, 'all');
  const targetInboxUri = actorInboxFor(harness.lensA, 'all');
  const undoResponse = await fetch(
    await harness.mastodon.signedUndo({
      actor: 'bob',
      targetInboxUri,
      targetActorUri,
      followActivityUri: staleFollowUri,
      undoActivityUri: 'https://mastodon.test/users/bob/activities/undo-before-follow',
    }),
  );
  assert.equal(undoResponse.status, 202);
  await drainAllQueues([harness.lensA]);
  const acceptsBeforeStaleFollow = harness.mastodon.recordedAccepts.length;
  await sendMastodonFollow(harness, {
    actor: 'bob',
    targetUsername: 'all',
    followActivityUri: staleFollowUri,
  });
  assert.equal(harness.mastodon.recordedAccepts.length, acceptsBeforeStaleFollow);

  await sendMastodonFollow(harness, {
    actor: 'bob',
    targetUsername: 'all',
    followActivityUri: 'https://mastodon.test/users/bob/activities/follow-all-current',
  });
  const state = await readState(harness.lensA);
  assert.ok(
    state.follows.some(
      (follow) =>
        follow.local_actor === 'all' &&
        follow.direction === 'inbound' &&
        follow.status === 'accepted' &&
        follow.remote_actor_uri === harness.mastodon.bobActorUri,
    ),
  );
}

async function sendMastodonFollow(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
  input: {
    actor: 'alice' | 'bob';
    targetUsername: 'project-a' | 'all';
    followActivityUri: string;
  },
) {
  const response = await fetch(
    await harness.mastodon.signedFollowToRemote({
      actor: input.actor,
      targetInboxUri: actorInboxFor(harness.lensA, input.targetUsername),
      targetActorUri: actorUriFor(harness.lensA, input.targetUsername),
      followActivityUri: input.followActivityUri,
    }),
  );
  assert.equal(response.status, 202, await response.clone().text());
  await drainAllQueues([harness.lensA]);
}

async function assertReportPublicationDelivery(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  harness.faultController.advance(60_000);
  await harness.lensA.control.publishReport({
    reportId: harness.lensA.reportId,
    publicSummary: 'Hermetic public summary from A',
  });
  const dispatchResponse = await harness.lensA.control.processDispatcher({ limit: 10 });
  const dispatch = await dispatchResponse.json();
  await drainAllQueues([harness.lensA, harness.lensB]);
  const stateB = await readState(harness.lensB);
  assert.equal((dispatch as { materialized?: number }).materialized, 2);
  const createReport = stateB.federatedReports.find((report) =>
    report.remote_activity_uri.includes('/activities/create/'),
  );
  assert.ok(createReport, JSON.stringify(stateB));
  assert.equal(createReport.title, 'Hermetic report project-a');
  assert.match(createReport.summary_html_sanitized, /Hermetic public summary from A/);
  assert.match(createReport.original_url, /\/reports\/public\/project-a\//);
}

async function assertMastodonTimelineProjection(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  assert.deepEqual(
    new Set(harness.mastodon.receivedActivityTypes),
    new Set(['Create', 'Announce']),
  );
  for (const activityType of ['Create', 'Announce'] as const) {
    const item = harness.mastodon.timeline.find((entry) => entry.activityType === activityType);
    assert.ok(item, `${activityType} timeline projection was not created`);
    assert.equal(item.title, 'Hermetic report project-a');
    assert.match(item.summary, /Hermetic public summary from A/);
    assert.match(item.reportUrl, /\/reports\/public\/project-a\//);
  }
}

async function assertRepresentationCanChangeBeforeOutbound(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const instance = harness.lensB;
  assert.equal(
    (await instance.control.updateRepresentation({ representation: 'note' })).status,
    200,
  );
  assert.equal(
    (await instance.control.updateRepresentation({ representation: 'article' })).status,
    200,
  );
}

async function assertRepresentationLocksAfterOutbound(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const locked = await harness.lensB.control.updateRepresentation({ representation: 'note' });
  assert.equal(locked.status, 409);
  const body = (await locked.json()) as { objectRepresentation?: string };
  assert.equal(body.objectRepresentation, 'article');
}

async function assertSharedInboxTraceAndDedupe(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const sharedTrace = harness.trace
    .snapshot()
    .filter(
      (entry) =>
        entry.host === 'mastodon.test' &&
        entry.path === '/inbox' &&
        (entry.activityType === 'Create' || entry.activityType === 'Announce') &&
        entry.signatureVerified !== undefined,
    );
  assert.equal(sharedTrace.length, 2, JSON.stringify(sharedTrace));
  for (const entry of sharedTrace) {
    assert.equal(entry.status, 202);
    assert.equal(entry.signed, true);
    assert.equal(entry.digestKind, 'rfc9421');
    assert.equal(entry.signatureVerified, true);
    assert.equal(entry.audienceUri, 'https://www.w3.org/ns/activitystreams#Public');
    assert.equal(entry.keyOwnerUri, `${harness.lensA.origin}/activitypub/actors/:actor`);
  }

  const timelineCount = harness.mastodon.timeline.length;
  const reportCount = (await readState(harness.lensB)).federatedReports.length;
  await harness.lensA.control.publishReport({
    reportId: harness.lensA.reportId,
    publicSummary: 'Hermetic public summary from A',
  });
  await harness.lensA.control.processDispatcher({ limit: 10 });
  await drainAllQueues([harness.lensA, harness.lensB]);
  assert.equal(harness.mastodon.timeline.length, timelineCount);
  assert.equal((await readState(harness.lensB)).federatedReports.length, reportCount);
}

async function assertFaultRecoveryScenarios(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const scenarios = [
    { fault: 'timeout' as const, errorCode: 'network_error', transportStatus: 599 },
    { fault: 'http_429' as const, errorCode: 'http_429', transportStatus: 429 },
    { fault: 'http_503' as const, errorCode: 'http_5xx', transportStatus: 503 },
    { fault: 'offline' as const, errorCode: 'network_error', transportStatus: 599 },
  ];
  for (const scenario of scenarios) {
    await undoLensSubscription(harness);
    const targetFollowCount = countInboundProjectFollowsFromA(await readState(harness.lensB));
    harness.faultController.setFault(
      { host: harness.lensB.host, pathPrefix: '/activitypub/inbox' },
      scenario.fault,
    );
    const followResponse = await harness.lensA.control.follow({
      projectSlug: harness.lensA.projectSlug,
      localActorPreferredUsername: harness.lensA.projectSlug,
      remoteActorAddress: buildRemoteLensActorAddress(
        harness.lensB.origin,
        harness.lensB.projectSlug,
      ),
    });
    assert.equal(followResponse.status, 200);
    const failedResponse = await harness.lensA.control.processQueue({ limit: 1 });
    const failed = (await failedResponse.json()) as { failed?: number };
    assert.equal(failed.failed, 1);
    const failedState = await readState(harness.lensA);
    const retryRow = [...failedState.queue]
      .reverse()
      .find((row) => row.status === 'retry_wait' && row.last_error_code === scenario.errorCode);
    assert.ok(retryRow, `${scenario.fault}: ${JSON.stringify(failedState.queue)}`);
    assert.equal(retryRow.attempt_count, 1);
    assert.ok(new Date(retryRow.available_at) > new Date(retryRow.database_now));
    const failedTransport = [...harness.trace.snapshot()]
      .reverse()
      .find((entry) => entry.host === harness.lensB.host && entry.path === '/activitypub/inbox');
    assert.equal(failedTransport?.status, scenario.transportStatus);

    harness.faultController.clearFaults();
    harness.faultController.advance(3_600_000);
    await drainAllQueues([harness.lensA, harness.lensB]);
    const recoveredState = await readState(harness.lensA);
    assertAcceptedOutboundProjectFollow(harness, recoveredState);
    assert.ok(
      recoveredState.queue.some((row) => row.status === 'succeeded' && row.attempt_count === 2),
    );
    assert.equal(
      countInboundProjectFollowsFromA(await readState(harness.lensB)),
      targetFollowCount,
    );
  }
}

async function assertAcceptThenFailIsIdempotent(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  await undoLensSubscription(harness);
  const beforeTarget = await readState(harness.lensB);
  harness.faultController.setFault(
    { host: harness.lensB.host, pathPrefix: '/activitypub/inbox' },
    'accept_then_fail',
  );
  await harness.lensA.control.follow({
    projectSlug: harness.lensA.projectSlug,
    localActorPreferredUsername: harness.lensA.projectSlug,
    remoteActorAddress: buildRemoteLensActorAddress(
      harness.lensB.origin,
      harness.lensB.projectSlug,
    ),
  });
  const failed = (await (await harness.lensA.control.processQueue({ limit: 1 })).json()) as {
    failed?: number;
  };
  assert.equal(failed.failed, 1);
  await drainAllQueues([harness.lensB, harness.lensA]);
  harness.faultController.clearFaults();
  harness.faultController.advance(3_600_000);
  await drainAllQueues([harness.lensA, harness.lensB]);
  const afterTarget = await readState(harness.lensB);
  const beforeCount = countInboundProjectFollowsFromA(beforeTarget);
  assert.equal(countInboundProjectFollowsFromA(afterTarget), beforeCount);
  assertAcceptedOutboundProjectFollow(harness, await readState(harness.lensA));
}

async function undoLensSubscription(harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>) {
  const state = await readState(harness.lensA);
  const follow = state.follows.find(
    (entry) =>
      entry.direction === 'outbound' &&
      entry.remote_actor_uri === actorUriFor(harness.lensB, harness.lensB.projectSlug),
  );
  assert.ok(follow);
  const response = await harness.lensA.control.undo({
    projectSlug: harness.lensA.projectSlug,
    localActorPreferredUsername: harness.lensA.projectSlug,
    remoteActorUri: follow.remote_actor_uri,
    remoteInboxUri: follow.remote_inbox_uri,
    remoteSharedInboxUri: `${harness.lensB.origin}/activitypub/inbox`,
  });
  assert.equal(response.status, 200);
  await drainAllQueues([harness.lensA, harness.lensB]);
  const undone = await readState(harness.lensA);
  assert.ok(
    undone.follows.some(
      (entry) =>
        entry.direction === 'outbound' &&
        entry.remote_actor_uri === follow.remote_actor_uri &&
        entry.status === 'undone',
    ),
  );
}

function assertAcceptedOutboundProjectFollow(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
  state: HermeticState,
) {
  assert.ok(
    state.follows.some(
      (entry) =>
        entry.direction === 'outbound' &&
        entry.status === 'accepted' &&
        entry.remote_actor_uri === actorUriFor(harness.lensB, harness.lensB.projectSlug),
    ),
    JSON.stringify(state.follows),
  );
}

function countInboundProjectFollowsFromA(state: HermeticState): number {
  return state.follows.filter(
    (entry) =>
      entry.local_actor === 'project-b' &&
      entry.direction === 'inbound' &&
      entry.remote_actor_uri === 'https://lens-a.test/activitypub/actors/project-a',
  ).length;
}

async function assertInvalidSignatureRejected(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const before = await readState(harness.lensA);
  const signed = await harness.mastodon.signedFollowToRemote({
    actor: 'alice',
    targetInboxUri: actorInboxFor(harness.lensA, 'project-a'),
    targetActorUri: actorUriFor(harness.lensA, 'project-a'),
    followActivityUri: 'https://mastodon.test/users/alice/activities/tampered-original',
  });
  const original = (await signed.clone().json()) as Record<string, unknown>;
  const tampered = new Request(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: JSON.stringify({
      ...original,
      id: 'https://mastodon.test/users/alice/activities/tampered-after-signing',
    }),
  });
  assert.equal((await fetch(tampered)).status, 401);
  await drainAllQueues([harness.lensA]);
  const after = await readState(harness.lensA);
  assert.equal(after.follows.length, before.follows.length);
}

async function assertProductionLoaderRejectsPrivateAddresses() {
  const loader = createProductionSafeDocumentLoader();
  await assert.rejects(() => loader.loadDocument('http://127.0.0.1/'));
  await assert.rejects(() => loader.loadDocument('http://10.0.0.1/'));
}

function assertSanitizedProtocolTrace(
  harness: Awaited<ReturnType<typeof createHermeticE2EHarness>>,
) {
  const artifact = JSON.stringify(harness.trace.snapshot());
  for (const forbidden of [
    '"headers"',
    '"body"',
    '"privateKey"',
    'BEGIN PRIVATE KEY',
    '"key_ops"',
    'project-a@hermetic.test',
    '70000000-0000-0000-0000-00000000000a',
    'acct:alice@mastodon.test',
  ]) {
    assert.equal(artifact.includes(forbidden), false, `trace leaked forbidden field: ${forbidden}`);
  }
}

type HermeticState = {
  follows: Array<{
    local_actor: string;
    direction: string;
    status: string;
    remote_actor_uri: string;
    remote_inbox_uri: string;
    follow_activity_uri: string;
  }>;
  queue: Array<{
    status: string;
    attempt_count: number;
    last_error_code: string | null;
    available_at: string;
    database_now: string;
  }>;
  federatedReports: Array<{
    remote_activity_uri: string;
    title: string;
    summary_html_sanitized: string;
    original_url: string;
  }>;
};

async function readState(
  instance: Awaited<ReturnType<typeof createHermeticE2EHarness>>['lensA'],
): Promise<HermeticState> {
  const response = await instance.control.state();
  assert.equal(response.status, 200);
  return (await response.json()) as HermeticState;
}
