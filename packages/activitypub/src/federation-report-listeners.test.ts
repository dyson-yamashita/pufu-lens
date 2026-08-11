import assert from 'node:assert/strict';
import test from 'node:test';
import { Announce, Create } from '@fedify/vocab';
import { createVerifiedInboxContextForTest } from './federation-follow-listeners.ts';
import {
  invokeVerifiedInboundAnnounceListenerForTest,
  invokeVerifiedInboundCreateListenerForTest,
} from './federation-report-listeners.ts';
import { createActivityPubInboundReportUseCases } from './inbound-report-use-cases.ts';

const remoteActorUri = 'https://remote.example/users/alice';
const articleId = 'https://remote.example/articles/1';

function createTrackingInboundReportUseCases() {
  let createProcessed = false;
  let announceProcessed = false;
  let resolved = false;
  let saved = false;
  const inboundReportUseCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        saved = true;
        return { saved: true };
      },
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        resolved = true;
        throw new Error('remote resolver must not be called');
      },
    },
    isDomainBlocked: () => false,
  });
  return {
    get createProcessed() {
      return createProcessed;
    },
    get announceProcessed() {
      return announceProcessed;
    },
    get resolved() {
      return resolved;
    },
    get saved() {
      return saved;
    },
    inboundReportUseCases: {
      processVerifiedInboundCreate: async (
        input: Parameters<typeof inboundReportUseCases.processVerifiedInboundCreate>[0],
      ) => {
        createProcessed = true;
        return inboundReportUseCases.processVerifiedInboundCreate(input);
      },
      processVerifiedInboundAnnounce: async (
        input: Parameters<typeof inboundReportUseCases.processVerifiedInboundAnnounce>[0],
      ) => {
        announceProcessed = true;
        return inboundReportUseCases.processVerifiedInboundAnnounce(input);
      },
    },
  };
}

function guardCreateAgainstGetObject(activity: Create): Create {
  activity.getObject = async () => {
    throw new Error('getObject must not be called for Create report listener');
  };
  return activity;
}

test('create listener rejects object URI without dereference or use-case side effects', async () => {
  const tracking = createTrackingInboundReportUseCases();
  const activity = guardCreateAgainstGetObject(
    await Create.fromJsonLd({
      id: 'https://remote.example/activities/create/uri-only',
      type: 'Create',
      actor: remoteActorUri,
      to: 'https://www.w3.org/ns/activitystreams#Public',
      object: articleId,
    }),
  );
  const ctx = createVerifiedInboxContextForTest({ signedActorUri: remoteActorUri });
  await invokeVerifiedInboundCreateListenerForTest({
    inboundReportUseCases: tracking.inboundReportUseCases,
    ctx,
    activity,
  });
  assert.equal(tracking.createProcessed, false);
  assert.equal(tracking.resolved, false);
});

test('create listener accepts embedded object from raw JSON-LD without calling getObject', async () => {
  const tracking = createTrackingInboundReportUseCases();
  const activity = guardCreateAgainstGetObject(
    await Create.fromJsonLd({
      id: 'https://remote.example/activities/create/embedded',
      type: 'Create',
      actor: remoteActorUri,
      to: 'https://www.w3.org/ns/activitystreams#Public',
      object: {
        type: 'Article',
        id: articleId,
        attributedTo: remoteActorUri,
        to: 'https://www.w3.org/ns/activitystreams#Public',
        name: 'title',
        content: '<p>hello</p>',
        url: articleId,
      },
    }),
  );
  const ctx = createVerifiedInboxContextForTest({ signedActorUri: remoteActorUri });
  await invokeVerifiedInboundCreateListenerForTest({
    inboundReportUseCases: tracking.inboundReportUseCases,
    ctx,
    activity,
  });
  assert.equal(tracking.createProcessed, true);
  assert.equal(tracking.resolved, false);
  assert.equal(tracking.saved, true);
});

test('create listener rejects signed owner mismatch without calling use case', async () => {
  let called = false;
  const inboundReportUseCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        called = true;
        return { saved: false };
      },
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: () => false,
  });
  const activity = await Create.fromJsonLd({
    id: 'https://remote.example/activities/create/1',
    type: 'Create',
    actor: remoteActorUri,
    to: 'https://www.w3.org/ns/activitystreams#Public',
    object: {
      type: 'Article',
      id: articleId,
      attributedTo: remoteActorUri,
      to: 'https://www.w3.org/ns/activitystreams#Public',
      name: 'title',
      content: '<p>hello</p>',
      url: articleId,
    },
  });
  const ctx = createVerifiedInboxContextForTest({
    signedActorUri: 'https://remote.example/users/bob',
  });
  await invokeVerifiedInboundCreateListenerForTest({
    inboundReportUseCases,
    ctx,
    activity,
  });
  assert.equal(called, false);
});

test('create listener ignores non-public audience without side effects', async () => {
  let called = false;
  const inboundReportUseCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        called = true;
        return { saved: false };
      },
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: () => false,
  });
  const activity = await Create.fromJsonLd({
    id: 'https://remote.example/activities/create/2',
    type: 'Create',
    actor: remoteActorUri,
    to: 'https://remote.example/followers/1',
    object: {
      type: 'Article',
      id: articleId,
      attributedTo: remoteActorUri,
      to: 'https://www.w3.org/ns/activitystreams#Public',
      name: 'title',
      content: '<p>hello</p>',
      url: articleId,
    },
  });
  const ctx = createVerifiedInboxContextForTest({ signedActorUri: remoteActorUri });
  await invokeVerifiedInboundCreateListenerForTest({
    inboundReportUseCases,
    ctx,
    activity,
  });
  assert.equal(called, false);
});

test('announce listener requires https object id', async () => {
  let called = false;
  const inboundReportUseCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        called = true;
        return { saved: false };
      },
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: () => false,
  });
  const activity = new Announce({
    id: new URL('https://remote.example/activities/announce/1'),
    actor: new URL(remoteActorUri),
    object: new URL('http://insecure.example/articles/1'),
    to: new URL('https://www.w3.org/ns/activitystreams#Public'),
  });
  const ctx = createVerifiedInboxContextForTest({ signedActorUri: remoteActorUri });
  await invokeVerifiedInboundAnnounceListenerForTest({
    inboundReportUseCases,
    ctx,
    activity,
  });
  assert.equal(called, false);
});
