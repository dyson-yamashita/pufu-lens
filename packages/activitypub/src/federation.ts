import type { KvStore } from '@fedify/fedify';
import { createFederationBuilder, type Federation, type MessageQueue } from '@fedify/fedify';
import { Article, Endpoints, Service } from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { ActivityPubRepository } from './actor-repository.ts';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import type { DeliveryErrorObserver } from './delivery-observer.ts';
import {
  createGlobalInboxListeners,
  registerFollowInboxHandlers,
} from './federation-follow-listeners.ts';
import { registerReportInboxHandlers } from './federation-report-listeners.ts';
import { FOLLOW_COLLECTION_START_CURSOR, resolveFollowCollectionCursor } from './follow-model.ts';
import type { ActivityPubFollowUseCases } from './follow-use-cases.ts';
import type { ActivityPubInboundReportUseCases } from './inbound-report-use-cases.ts';
import { escapeNoteContentText } from './report-delivery.ts';
import { createProductionSafeDocumentLoader } from './security.ts';
import {
  assertActivityPubDbTestRuntime,
  assertActivityPubListenerHarnessRuntime,
} from './test-runtime-guard.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

type FederationBuildInput = {
  canonicalOrigin: string;
  repository: ActivityPubRepository;
  followUseCases?: ActivityPubFollowUseCases;
  inboundReportUseCases?: ActivityPubInboundReportUseCases;
  kv: KvStore;
  queue: MessageQueue;
  queueHooks?: {
    /** Observation sentinel for tests; never invoked by the Web runtime. */
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
  /** Scoped observer for one dispatcher-owned delivery attempt; records safe mapped errors only. */
  deliveryObserver?: DeliveryErrorObserver;
  allowPrivateAddress: boolean;
};

/** Creates the production ActivityPub federation with Step 2 public dispatchers. */
export async function createProductionActivityPubFederation(input: {
  canonicalOrigin: string;
  repository: ActivityPubRepository;
  followUseCases?: ActivityPubFollowUseCases;
  inboundReportUseCases?: ActivityPubInboundReportUseCases;
  kv: KvStore;
  queue: MessageQueue;
  queueHooks?: FederationBuildInput['queueHooks'];
  deliveryObserver?: DeliveryErrorObserver;
}): Promise<Federation<undefined>> {
  return buildActivityPubFederation({
    ...input,
    allowPrivateAddress: false,
  });
}

/**
 * Test-only federation builder that can allow private addresses for hermetic localhost fixtures.
 * Must not be used from production runtime entrypoints.
 */
export async function createTestActivityPubFederation(
  input: Omit<FederationBuildInput, 'allowPrivateAddress'> & {
    allowPrivateAddress?: boolean;
  },
): Promise<Federation<undefined>> {
  assertActivityPubListenerHarnessRuntime();
  if (input.allowPrivateAddress ?? false) {
    assertActivityPubDbTestRuntime();
  }
  return buildActivityPubFederation({
    ...input,
    allowPrivateAddress: input.allowPrivateAddress ?? false,
  });
}

async function buildActivityPubFederation(
  input: FederationBuildInput,
): Promise<Federation<undefined>> {
  const { origin } = parseCanonicalOrigin(input.canonicalOrigin);
  const uri = buildActivityPubUriContract(origin);
  await input.repository.ensureAggregateActor();

  const builder = createFederationBuilder<undefined>();
  builder
    .setActorDispatcher('/activitypub/actors/{identifier}', async (_ctx, identifier: string) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor) {
        return null;
      }
      return new Service({
        id: new URL(uri.actorUrl(actor.preferredUsername)),
        preferredUsername: actor.preferredUsername,
        name: actor.displayName,
        inbox: new URL(uri.personalInboxUrl(actor.preferredUsername)),
        outbox: new URL(uri.actorOutboxUrl(actor.preferredUsername)),
        followers: new URL(uri.actorFollowersUrl(actor.preferredUsername)),
        following: new URL(uri.actorFollowingUrl(actor.preferredUsername)),
        endpoints: new Endpoints({
          sharedInbox: new URL(uri.sharedInboxUrl),
        }),
        url: new URL(uri.actorUrl(actor.preferredUsername)),
      });
    })
    .setKeyPairsDispatcher(async (_ctx, identifier: string) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor) {
        return [];
      }
      const keyPair = await input.repository.importActorCryptoKeyPair(actor.id);
      return [keyPair];
    })
    .mapHandle(async (_ctx, username: string) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(username);
      return actor ? actor.preferredUsername : null;
    });

  builder.setObjectDispatcher(Article, '/activitypub/reports/{reportId}', async (_ctx, values) => {
    const config = await input.repository.getInstanceConfig();
    if (config.objectRepresentation !== 'article') {
      return null;
    }
    const report = await input.repository.findPublicReportArticle(values.reportId);
    if (!report) {
      return null;
    }
    const projectActorUrl = new URL(uri.actorUrl(report.preferredUsername));
    return new Article({
      id: new URL(uri.reportArticleUrl(report.reportId)),
      name: report.title,
      summary: report.summary,
      content: escapeNoteContentText(report.summary),
      published: Temporal.Instant.from(report.publishedAt.toISOString()),
      attribution: projectActorUrl,
      url: new URL(uri.publicReportUrl(report.projectSlug, report.reportId)),
      to: new URL('https://www.w3.org/ns/activitystreams#Public'),
      cc: new URL(uri.actorFollowersUrl(report.preferredUsername)),
    });
  });

  builder.setOutboxDispatcher(
    '/activitypub/actors/{identifier}/outbox',
    async (_ctx, identifier: string) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor) {
        return null;
      }
      return { items: [], nextCursor: undefined };
    },
  );

  const followersSetters = builder.setFollowersDispatcher(
    '/activitypub/actors/{identifier}/followers',
    async (_ctx, identifier, cursor) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor || !input.followUseCases) {
        return actor ? { items: [], nextCursor: undefined } : null;
      }
      const page = await input.followUseCases.listAcceptedFollowCollection({
        localActorId: actor.id,
        direction: 'inbound',
        cursor: resolveFollowCollectionCursor(cursor),
      });
      return {
        items: page.items.map((item) => ({
          id: new URL(item.actorUri),
          inboxId: null,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
  followersSetters.setCounter(async (_ctx, identifier) => {
    const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
    if (!actor || !input.followUseCases) {
      return actor ? 0 : null;
    }
    return input.followUseCases.countAcceptedFollowCollection({
      localActorId: actor.id,
      direction: 'inbound',
    });
  });
  followersSetters.setFirstCursor(async (_ctx, identifier) => {
    const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
    if (!actor) {
      return null;
    }
    return FOLLOW_COLLECTION_START_CURSOR;
  });

  const followingSetters = builder.setFollowingDispatcher(
    '/activitypub/actors/{identifier}/following',
    async (_ctx, identifier, cursor) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor || !input.followUseCases) {
        return actor ? { items: [], nextCursor: undefined } : null;
      }
      const page = await input.followUseCases.listAcceptedFollowCollection({
        localActorId: actor.id,
        direction: 'outbound',
        cursor: resolveFollowCollectionCursor(cursor),
      });
      return {
        items: page.items.map((item) => new URL(item.actorUri)),
        nextCursor: page.nextCursor,
      };
    },
  );
  followingSetters.setCounter(async (_ctx, identifier) => {
    const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
    if (!actor || !input.followUseCases) {
      return actor ? 0 : null;
    }
    return input.followUseCases.countAcceptedFollowCollection({
      localActorId: actor.id,
      direction: 'outbound',
    });
  });
  followingSetters.setFirstCursor(async (_ctx, identifier) => {
    const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
    if (!actor) {
      return null;
    }
    return FOLLOW_COLLECTION_START_CURSOR;
  });

  if (input.followUseCases || input.inboundReportUseCases) {
    const listeners = createGlobalInboxListeners(builder);
    if (input.followUseCases) {
      registerFollowInboxHandlers(listeners, {
        canonicalOrigin: origin,
        actorRepository: input.repository,
        followUseCases: input.followUseCases,
      });
    }
    if (input.inboundReportUseCases) {
      registerReportInboxHandlers(listeners, {
        inboundReportUseCases: input.inboundReportUseCases,
      });
    }
  } else {
    builder.setInboxListeners('/activitypub/actors/{identifier}/inbox', '/activitypub/inbox');
  }

  const federation = (await builder.build({
    kv: input.kv,
    queue: input.queue,
    manuallyStartQueue: true,
    allowPrivateAddress: input.allowPrivateAddress,
    permanentFailureStatusCodes: [],
    onOutboxError: (error) => {
      input.deliveryObserver?.record(error);
    },
    ...(input.allowPrivateAddress
      ? {}
      : {
          documentLoaderFactory: () => createProductionSafeDocumentLoader(),
          contextLoaderFactory: () => createProductionSafeDocumentLoader(),
        }),
    origin,
  })) as Federation<undefined>;

  attachQueueHooks(federation, input.queueHooks);
  return federation;
}

function attachQueueHooks(
  federation: Federation<undefined>,
  queueHooks?: FederationBuildInput['queueHooks'],
): void {
  if (!queueHooks) {
    return;
  }

  // The Web process must never start queue consumption. `listen` stays deliberately unwired
  // because only out-of-process workers may attach a live queue consumer.
  void queueHooks.listen;

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
