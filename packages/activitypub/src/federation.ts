import type { KvStore } from '@fedify/fedify';
import { createFederationBuilder, type Federation, type MessageQueue } from '@fedify/fedify';
import { Article, Endpoints, Service } from '@fedify/vocab';
import { Temporal } from '@js-temporal/polyfill';
import type { ActivityPubRepository } from './actor-repository.ts';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import { createProductionSafeDocumentLoader } from './security.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

/** Creates the production ActivityPub federation with Step 2 public dispatchers. */
export async function createProductionActivityPubFederation(input: {
  canonicalOrigin: string;
  repository: ActivityPubRepository;
  kv: KvStore;
  queue: MessageQueue;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
}): Promise<Federation<undefined>> {
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
    return new Article({
      id: new URL(uri.reportArticleUrl(report.reportId)),
      name: report.title,
      summary: report.summary,
      published: Temporal.Instant.from(report.publishedAt.toISOString()),
      attribution: new URL(uri.actorUrl(report.preferredUsername)),
      url: new URL(uri.publicReportUrl(report.projectSlug, report.reportId)),
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

  builder.setFollowersDispatcher(
    '/activitypub/actors/{identifier}/followers',
    async (_ctx, identifier: string) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor) {
        return null;
      }
      return { items: [], nextCursor: undefined };
    },
  );

  builder.setFollowingDispatcher(
    '/activitypub/actors/{identifier}/following',
    async (_ctx, identifier: string) => {
      const actor = await input.repository.findRemotelyVisibleActorByUsername(identifier);
      if (!actor) {
        return null;
      }
      return { items: [], nextCursor: undefined };
    },
  );

  builder.setInboxListeners('/activitypub/actors/{identifier}/inbox', '/activitypub/inbox');

  const federation = (await builder.build({
    kv: input.kv,
    queue: input.queue,
    manuallyStartQueue: true,
    allowPrivateAddress: false,
    documentLoaderFactory: () => createProductionSafeDocumentLoader(),
    contextLoaderFactory: () => createProductionSafeDocumentLoader(),
    origin,
  })) as Federation<undefined>;

  attachQueueHooks(federation, input.queueHooks);
  return federation;
}

function attachQueueHooks(
  federation: Federation<undefined>,
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  },
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
