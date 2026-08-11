import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityPubInboundReportUseCases } from './inbound-report-use-cases.ts';
import { ACTIVITYSTREAMS_PUBLIC_URI } from './remote-article.ts';

const remoteActorUri = 'https://remote.example/users/alice';
const articleId = 'https://remote.example/articles/1?q=1';

function buildArticleObject(overrides: Record<string, unknown> = {}) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Article',
    id: articleId,
    attributedTo: remoteActorUri,
    to: ACTIVITYSTREAMS_PUBLIC_URI,
    name: 'Inbound report',
    content: '<p>hello</p>',
    url: articleId,
    ...overrides,
  };
}

function buildResolvedArticle(
  overrides: Partial<{
    articleId: string;
    attributedTo: string;
    title: string;
    summaryHtml: string;
    originalUrl: string;
  }> = {},
) {
  return {
    articleId,
    attributedTo: remoteActorUri,
    title: 'Inbound report',
    summaryHtml: '<p>hello</p>',
    originalUrl: articleId,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: null,
    ...overrides,
  };
}

test('processVerifiedInboundCreate rejects blocked source actor domain', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: (host) => host === 'blocked.example',
  });
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/1',
    sourceActorUri: 'https://blocked.example/users/alice',
    recipientPreferredUsername: null,
    embeddedObject: buildArticleObject({
      attributedTo: 'https://blocked.example/users/alice',
    }),
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_object' });
});

test('processVerifiedInboundCreate rejects non-article objects without persistence', async () => {
  let saved = false;
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        saved = true;
        return { saved: true };
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
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/2',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    embeddedObject: {
      type: 'Note',
      id: articleId,
      attributedTo: remoteActorUri,
      to: ACTIVITYSTREAMS_PUBLIC_URI,
      content: 'hello',
    },
  });
  assert.equal(saved, false);
  assert.deepEqual(result, { kind: 'rejected', code: 'unsupported_type' });
});

test('processVerifiedInboundCreate saves valid embedded Article', async () => {
  let persisted = false;
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        persisted = true;
        return { saved: true };
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
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/save',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    embeddedObject: buildArticleObject(),
  });
  assert.equal(persisted, true);
  assert.deepEqual(result, { kind: 'saved' });
});

test('processVerifiedInboundCreate rejects spoofed attribution', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: () => false,
  });
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/spoof',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    embeddedObject: buildArticleObject({
      attributedTo: 'https://remote.example/users/bob',
    }),
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_object' });
});

test('processVerifiedInboundCreate rejects non-public Article audience', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: () => false,
  });
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/private',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    embeddedObject: buildArticleObject({
      to: 'https://remote.example/followers/only',
    }),
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_activity' });
});

test('processVerifiedInboundCreate returns ignored when repository has no matching follow', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: false }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: () => false,
  });
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/ignored',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: 'missing-project',
    embeddedObject: buildArticleObject(),
  });
  assert.deepEqual(result, { kind: 'ignored' });
});

test('processVerifiedInboundCreate rejects blocked article original URL', async () => {
  const blockedArticleId = 'https://blocked.example/articles/1';
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: (host) => host === 'blocked.example',
  });
  const result = await useCases.processVerifiedInboundCreate({
    activityUri: 'https://remote.example/activities/create/blocked-url',
    sourceActorUri: 'https://blocked.example/users/alice',
    recipientPreferredUsername: null,
    embeddedObject: buildArticleObject({
      id: blockedArticleId,
      url: blockedArticleId,
      attributedTo: 'https://blocked.example/users/alice',
    }),
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_object' });
});

test('processVerifiedInboundAnnounce saves resolved Article', async () => {
  let persisted = false;
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => {
        persisted = true;
        return { saved: true };
      },
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => buildResolvedArticle(),
    },
    isDomainBlocked: () => false,
  });
  const result = await useCases.processVerifiedInboundAnnounce({
    activityUri: 'https://remote.example/activities/announce/save',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    objectUri: articleId,
  });
  assert.equal(persisted, true);
  assert.deepEqual(result, { kind: 'saved' });
});

test('processVerifiedInboundAnnounce allows different attributedTo from announce actor', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () =>
        buildResolvedArticle({
          attributedTo: 'https://remote.example/users/editor',
        }),
    },
    isDomainBlocked: () => false,
  });
  const result = await useCases.processVerifiedInboundAnnounce({
    activityUri: 'https://remote.example/activities/announce/attribution',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    objectUri: articleId,
  });
  assert.deepEqual(result, { kind: 'saved' });
});

test('processVerifiedInboundAnnounce rejects blocked source actor', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: { resolve: async () => buildResolvedArticle() },
    isDomainBlocked: (host) => host === 'blocked.example',
  });
  const result = await useCases.processVerifiedInboundAnnounce({
    activityUri: 'https://remote.example/activities/announce/blocked-actor',
    sourceActorUri: 'https://blocked.example/users/alice',
    recipientPreferredUsername: null,
    objectUri: articleId,
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_object' });
});

test('processVerifiedInboundAnnounce rejects blocked object URL', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('should not resolve');
      },
    },
    isDomainBlocked: (host) => host === 'blocked.example',
  });
  const result = await useCases.processVerifiedInboundAnnounce({
    activityUri: 'https://remote.example/activities/announce/blocked-object',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    objectUri: 'https://blocked.example/articles/1',
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_object' });
});

test('processVerifiedInboundAnnounce rejects resolver failures', async () => {
  const useCases = createActivityPubInboundReportUseCases({
    federatedReportRepository: {
      saveInboundReport: async () => ({ saved: true }),
      listByProject: async () => [],
    },
    remoteArticleResolver: {
      resolve: async () => {
        throw new Error('resolve failed');
      },
    },
    isDomainBlocked: () => false,
  });
  const result = await useCases.processVerifiedInboundAnnounce({
    activityUri: 'https://remote.example/activities/announce/resolve-fail',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    objectUri: articleId,
  });
  assert.deepEqual(result, { kind: 'rejected', code: 'invalid_object' });
});
