import {
  createFederation,
  createFederationBuilder,
  type Federation,
  generateCryptoKeyPair,
  MemoryKvStore,
} from '@fedify/fedify';
import { Article, Endpoints, Service } from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import { createProductionSafeDocumentLoader } from './security.ts';

export type ActivityPubReportFixture = {
  /** Public report identifier used in ActivityPub object URLs. */
  reportId: string;
  /** Project slug used in the user-facing public report URL. */
  projectSlug: string;
  title: string;
  summary: string;
  publishedAt: Date;
};

/** Input for the in-memory Fedify protocol fixture used by Step 1 contract tests. */
export type ActivityPubProtocolFixtureInput = {
  canonicalOrigin?: string;
  preferredUsername: string;
  report: ActivityPubReportFixture;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
};

/** Built protocol fixture exposing both the wrapped fetch client and raw Fedify federation. */
export type ActivityPubProtocolFixture = {
  federation: FederationFixtureClient;
  rawFederation: Federation<undefined>;
  canonicalOrigin: string;
  preferredUsername: string;
  report: ActivityPubReportFixture;
};

type FederationFixtureClient = {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_CANONICAL_ORIGIN = 'https://lens.test';

/** Stable URI helpers for ActivityPub protocol resources. */
export const ACTIVITYPUB_URI_CONTRACT = {
  canonicalHost: new URL(DEFAULT_CANONICAL_ORIGIN).host,
  canonicalOrigin: DEFAULT_CANONICAL_ORIGIN,
  webfingerAcct(preferredUsername: string) {
    return `acct:${preferredUsername}@${ACTIVITYPUB_URI_CONTRACT.canonicalHost}`;
  },
  actorUrl(preferredUsername: string) {
    return `${ACTIVITYPUB_URI_CONTRACT.canonicalOrigin}/activitypub/actors/${preferredUsername}`;
  },
  personalInboxUrl(preferredUsername: string) {
    return `${ACTIVITYPUB_URI_CONTRACT.canonicalOrigin}/activitypub/actors/${preferredUsername}/inbox`;
  },
  sharedInboxUrl: `${DEFAULT_CANONICAL_ORIGIN}/activitypub/inbox`,
  reportArticleUrl(reportId: string) {
    return `${ACTIVITYPUB_URI_CONTRACT.canonicalOrigin}/activitypub/reports/${reportId}`;
  },
  publicReportUrl(projectSlug: string, reportId: string) {
    return `${ACTIVITYPUB_URI_CONTRACT.canonicalOrigin}/reports/public/${projectSlug}/${reportId}`;
  },
} as const;

/** Resolves the stable Create activity ID for a public report notification. */
export function resolveStableCreateActivityId(input: {
  canonicalOrigin: string;
  reportId: string;
  preferredUsername: string;
}): string {
  parseCanonicalOrigin(input.canonicalOrigin);
  return `${input.canonicalOrigin}/activitypub/activities/create/${input.reportId}`;
}

/** Creates an in-memory Fedify protocol fixture for contract tests. */
export async function createActivityPubProtocolFixture(
  input: ActivityPubProtocolFixtureInput,
): Promise<ActivityPubProtocolFixture> {
  const canonicalOrigin = input.canonicalOrigin ?? DEFAULT_CANONICAL_ORIGIN;
  const { origin } = parseCanonicalOrigin(canonicalOrigin, { allowHttpLocalhost: true });
  const { preferredUsername, report } = input;
  const actorId = `${origin}/activitypub/actors/${preferredUsername}`;
  const personalInbox = `${origin}/activitypub/actors/${preferredUsername}/inbox`;
  const outbox = `${origin}/activitypub/actors/${preferredUsername}/outbox`;
  const sharedInbox = `${origin}/activitypub/inbox`;
  const articleId = `${origin}/activitypub/reports/${report.reportId}`;
  const publicReportUrl = `${origin}/reports/public/${report.projectSlug}/${report.reportId}`;
  const fixtureActorKeyPair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');

  const builder = createFederationBuilder<undefined>();
  builder
    .setActorDispatcher('/activitypub/actors/{identifier}', async (_ctx, identifier: string) => {
      if (identifier !== preferredUsername) {
        return null;
      }
      return new Service({
        id: new URL(actorId),
        preferredUsername,
        name: report.title,
        inbox: new URL(personalInbox),
        outbox: new URL(outbox),
        endpoints: new Endpoints({
          sharedInbox: new URL(sharedInbox),
        }),
        url: new URL(publicReportUrl),
      });
    })
    .setKeyPairsDispatcher(async (_ctx, identifier: string) => {
      if (identifier !== preferredUsername) {
        return [];
      }
      return [fixtureActorKeyPair];
    })
    .mapHandle(async (_ctx, username: string) =>
      username === preferredUsername ? preferredUsername : null,
    );
  builder.setObjectDispatcher(Article, '/activitypub/reports/{reportId}', async (_ctx, values) => {
    if (values.reportId !== report.reportId) {
      return null;
    }
    return new Article({
      id: new URL(articleId),
      name: report.title,
      summary: report.summary,
      published: Temporal.Instant.from(report.publishedAt.toISOString()),
      attribution: new URL(actorId),
      url: new URL(publicReportUrl),
    });
  });
  builder.setOutboxDispatcher(
    '/activitypub/actors/{identifier}/outbox',
    async (_ctx, identifier: string) => {
      if (identifier !== preferredUsername) {
        return { items: [], nextCursor: undefined };
      }
      return { items: [], nextCursor: undefined };
    },
  );
  builder.setInboxListeners('/activitypub/actors/{identifier}/inbox', '/activitypub/inbox');

  const federation = (await builder.build({
    kv: new MemoryKvStore(),
    manuallyStartQueue: true,
    allowPrivateAddress: false,
    documentLoaderFactory: () => createProductionSafeDocumentLoader(),
    contextLoaderFactory: () => createProductionSafeDocumentLoader(),
    origin,
  })) as Federation<undefined>;

  attachQueueHooks(federation, input.queueHooks);

  return {
    canonicalOrigin: origin,
    preferredUsername,
    report,
    rawFederation: federation,
    federation: wrapFederationFetch(federation),
  };
}

/** Creates a manually started Fedify federation for web runtime contract tests. */
export async function createActivityPubWebFederation(input: {
  canonicalOrigin: string;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
}) {
  const { origin } = parseCanonicalOrigin(input.canonicalOrigin);
  const queue = {
    nativeRetrial: true as const,
    async enqueue() {
      return undefined;
    },
    async listen(): Promise<void> {
      input.queueHooks?.listen?.();
      await new Promise<void>(() => undefined);
    },
  };

  const federation = createFederation({
    kv: new MemoryKvStore(),
    queue,
    manuallyStartQueue: true,
    allowPrivateAddress: false,
    documentLoaderFactory: () => createProductionSafeDocumentLoader(),
    contextLoaderFactory: () => createProductionSafeDocumentLoader(),
    origin,
  }) as Federation<undefined>;

  const originalStartQueue = federation.startQueue.bind(federation);
  federation.startQueue = ((...args: Parameters<typeof federation.startQueue>) => {
    input.queueHooks?.startQueue?.();
    return originalStartQueue(...args);
  }) as typeof federation.startQueue;

  const originalProcessQueuedTask = federation.processQueuedTask.bind(federation);
  federation.processQueuedTask = ((...args: Parameters<typeof federation.processQueuedTask>) => {
    input.queueHooks?.processQueuedTask?.();
    return originalProcessQueuedTask(...args);
  }) as typeof federation.processQueuedTask;

  return wrapFederationFetch(federation);
}

function attachQueueHooks(
  federation: Federation<undefined>,
  queueHooks?: ActivityPubProtocolFixtureInput['queueHooks'],
): void {
  if (!queueHooks) {
    return;
  }

  const originalStartQueue = federation.startQueue.bind(federation);
  federation.startQueue = ((...args: Parameters<typeof federation.startQueue>) => {
    queueHooks.startQueue?.();
    return originalStartQueue(...args);
  }) as typeof federation.startQueue;

  const originalProcessQueuedTask = federation.processQueuedTask.bind(federation);
  federation.processQueuedTask = ((...args: Parameters<typeof federation.processQueuedTask>) => {
    queueHooks.processQueuedTask?.();
    return originalProcessQueuedTask(...args);
  }) as typeof federation.processQueuedTask;
}

function wrapFederationFetch(federation: Federation<undefined>): FederationFixtureClient {
  return {
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const request =
        typeof input === 'string'
          ? new Request(input, init)
          : input instanceof URL
            ? new Request(input, init)
            : input;
      return federation.fetch(request, { contextData: undefined });
    },
  };
}
