import type { MessageQueue } from '@fedify/fedify';
import type postgres from 'postgres';
import type { ActivityPubRepository } from './actor-repository.ts';
import {
  createPostgresActivityPubRepository,
  createPostgresActivityPubTransactionRepository,
} from './actor-repository.ts';
import type { FollowTransitionResult } from './follow-model.ts';
import { enqueueFollowTransitionOutbox } from './follow-outbox-enqueue.ts';
import {
  type ActivityPubFollowRepository,
  createPostgresActivityPubFollowRepository,
  createPostgresActivityPubFollowTransactionRepository,
  type OutboundFollowInput,
  type OutboundUndoInput,
} from './follow-repository.ts';
import { createPostgresQueueAdapter } from './postgres.ts';
import type { PostgresQueueEnqueueOptions } from './queue.ts';
import {
  createRemoteActorResolver,
  type RemoteActorReadModel,
  type RemoteActorResolver,
} from './remote-actor.ts';
import type { ActivityPubFollow } from './schema.ts';

/** Project-scoped outbound subscription row for admin UI. */
export type ProjectOutboundSubscriptionView = {
  readonly remoteActorAddress: string;
  readonly status: ActivityPubFollow['status'];
};

/** Follower/following collection item exposed through federation dispatchers. */
export type FollowCollectionItem = {
  readonly actorUri: string;
};

/** Follow collection page returned by federation dispatchers. */
export type FollowCollectionPage = {
  readonly items: readonly FollowCollectionItem[];
  readonly nextCursor?: string;
  readonly totalItems: number;
};

/** Verified inbound follow mutation input from federation listeners. */
export type VerifiedInboundFollowInput = {
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  localActorUri: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
  followActivityUri: string;
};

/** Verified inbound Accept receipt input from federation listeners. */
export type VerifiedInboundAcceptInput = {
  localActorId?: string;
  remoteActorUri: string;
  followActivityUri: string;
  acceptActivityUri: string;
};

/** Verified inbound Undo(Follow) input from federation listeners. */
export type VerifiedInboundUndoInput = {
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  localActorUri: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
  undoActivityUri: string;
  embeddedFollowActivityUri: string;
};

/** ActivityPub follow use cases for admin mutations and federation listeners. */
export type ActivityPubFollowUseCases = {
  requestOutboundFollow(input: {
    projectSlug: string;
    localActorId: string;
    localActorPreferredUsername: string;
    localActorKeyId: string;
    remoteActorAddress: string;
  }): Promise<{ follow: ActivityPubFollow; enqueued: boolean }>;
  requestOutboundUndo(input: {
    projectSlug: string;
    localActorId: string;
    localActorPreferredUsername: string;
    localActorKeyId: string;
    remoteActorUri: string;
    remoteInboxUri: string;
    remoteSharedInboxUri: string | null;
  }): Promise<{ follow: ActivityPubFollow; enqueued: boolean } | null>;
  processVerifiedInboundFollow(input: VerifiedInboundFollowInput): Promise<{
    processed: boolean;
    enqueued: boolean;
  }>;
  processVerifiedInboundAccept(input: VerifiedInboundAcceptInput): Promise<{
    processed: boolean;
  }>;
  processVerifiedInboundUndo(input: VerifiedInboundUndoInput): Promise<{
    processed: boolean;
  }>;
  listProjectOutboundSubscriptions(
    projectId: string,
  ): Promise<readonly ProjectOutboundSubscriptionView[]>;
  listAcceptedFollowCollection(input: {
    localActorId: string;
    direction: 'inbound' | 'outbound';
    cursor?: string;
  }): Promise<FollowCollectionPage>;
  countAcceptedFollowCollection(input: {
    localActorId: string;
    direction: 'inbound' | 'outbound';
  }): Promise<number>;
  resolveRemoteActor(address: string): Promise<RemoteActorReadModel>;
  getRepository(): ActivityPubFollowRepository;
};

export type CreateActivityPubFollowUseCasesInput = {
  canonicalOrigin: string;
  repository: ActivityPubFollowRepository;
  actorRepository: ActivityPubRepository;
  remoteActorResolver?: RemoteActorResolver;
  isDomainBlocked?: (hostname: string) => boolean;
  fetch?: typeof fetch;
  /** Hermetic tests inject a queue adapter without PostgreSQL. */
  testQueue?: OutboxQueue;
};

export type CreateActivityPubFollowUseCasesWithSqlInput = {
  canonicalOrigin: string;
  sql: postgres.Sql;
  encryptionKey: Buffer;
  actorRepository?: ActivityPubRepository;
  remoteActorResolver?: RemoteActorResolver;
  isDomainBlocked?: (hostname: string) => boolean;
  fetch?: typeof fetch;
  enqueueOutbox?: boolean;
};

type OutboxQueue = MessageQueue & {
  enqueue(message: unknown, options?: PostgresQueueEnqueueOptions): Promise<void>;
};

type UseCaseInput =
  | CreateActivityPubFollowUseCasesInput
  | CreateActivityPubFollowUseCasesWithSqlInput;

/**
 * Creates follow use cases backed by an existing repository and optional remote resolver.
 * Outbound mutations require an enabled local actor and validated remote endpoints.
 */
export function createActivityPubFollowUseCases(input: UseCaseInput): ActivityPubFollowUseCases {
  const canonicalOrigin = input.canonicalOrigin;
  const repository =
    'repository' in input
      ? input.repository
      : createPostgresActivityPubFollowRepository({ sql: input.sql });
  const actorRepository: ActivityPubRepository =
    'repository' in input
      ? input.actorRepository
      : (input.actorRepository ??
        createPostgresActivityPubRepository({
          sql: input.sql,
          encryptionKey: input.encryptionKey,
        }));
  const remoteResolver =
    input.remoteActorResolver ??
    createRemoteActorResolver({
      canonicalOrigin,
      fetch: input.fetch ?? fetch,
      isDomainBlocked: input.isDomainBlocked ?? (() => false),
    });

  const enqueueEnabled =
    ('sql' in input && input.enqueueOutbox !== false) ||
    ('testQueue' in input && input.testQueue !== undefined);
  const queue = 'testQueue' in input ? input.testQueue : undefined;

  const enqueueOutbox = async (input: {
    queue: OutboxQueue;
    actorRepository: ActivityPubRepository;
    outboxEnqueue: NonNullable<FollowTransitionResult['outboxEnqueue']>;
  }): Promise<void> => {
    await enqueueFollowTransitionOutbox({
      canonicalOrigin,
      actorRepository: input.actorRepository,
      queue: input.queue,
      outboxEnqueue: input.outboxEnqueue,
    });
  };

  type TransactionalMutationResources = {
    repo: ActivityPubFollowRepository;
    queue: OutboxQueue;
    actorRepository: ActivityPubRepository;
  };

  const runTransactionalMutation = async <T>(
    mutation: (repo: ActivityPubFollowRepository) => Promise<T>,
    afterMutation?: (resources: TransactionalMutationResources, result: T) => Promise<void>,
  ): Promise<T> => {
    if ('sql' in input && enqueueEnabled) {
      return input.sql.begin(async (tx) => {
        const txRepo = createPostgresActivityPubFollowTransactionRepository({ sql: tx });
        const txQueue = createPostgresQueueAdapter({ sql: tx, canonicalOrigin });
        const txActorRepository = createPostgresActivityPubTransactionRepository({
          sql: tx,
          encryptionKey: input.encryptionKey,
        });
        const resources: TransactionalMutationResources = {
          repo: txRepo,
          queue: txQueue,
          actorRepository: txActorRepository,
        };
        const result = await mutation(txRepo);
        if (afterMutation) {
          await afterMutation(resources, result);
        }
        return result;
      }) as Promise<T>;
    }
    if (queue) {
      return repository.runInTransaction(async (txRepo) => {
        const resources: TransactionalMutationResources = {
          repo: txRepo,
          queue,
          actorRepository,
        };
        const result = await mutation(txRepo);
        if (afterMutation) {
          await afterMutation(resources, result);
        }
        return result;
      });
    }
    return mutation(repository);
  };

  const enqueueTransitionIfPresent = async (
    resources: TransactionalMutationResources,
    result: FollowTransitionResult | null,
  ): Promise<void> => {
    if (result?.outboxEnqueue) {
      await enqueueOutbox({
        queue: resources.queue,
        actorRepository: resources.actorRepository,
        outboxEnqueue: result.outboxEnqueue,
      });
    }
  };

  return {
    getRepository: () => repository,
    resolveRemoteActor: (address) => remoteResolver.resolve(address),
    async requestOutboundFollow(params) {
      const remote = await remoteResolver.resolve(params.remoteActorAddress);
      const result = await runTransactionalMutation(
        (repo) =>
          repo.requestOutboundFollow({
            canonicalOrigin,
            localActorId: params.localActorId,
            localActorPreferredUsername: params.localActorPreferredUsername,
            localActorKeyId: params.localActorKeyId,
            remoteActorUri: remote.actorUri,
            remoteInboxUri: remote.inboxUri,
            remoteSharedInboxUri: remote.sharedInboxUri,
          } satisfies OutboundFollowInput),
        async (resources, result) => {
          await enqueueTransitionIfPresent(resources, result);
        },
      );
      return {
        follow: result.follow,
        enqueued: Boolean(result.outboxEnqueue && enqueueEnabled),
      };
    },
    async requestOutboundUndo(params) {
      const result = await runTransactionalMutation(
        (repo) =>
          repo.requestOutboundUndo({
            canonicalOrigin,
            localActorId: params.localActorId,
            localActorPreferredUsername: params.localActorPreferredUsername,
            localActorKeyId: params.localActorKeyId,
            remoteActorUri: params.remoteActorUri,
            remoteInboxUri: params.remoteInboxUri,
            remoteSharedInboxUri: params.remoteSharedInboxUri,
          } satisfies OutboundUndoInput),
        async (resources, mutationResult) => {
          await enqueueTransitionIfPresent(resources, mutationResult);
        },
      );
      if (!result) {
        return null;
      }
      return {
        follow: result.follow,
        enqueued: Boolean(result.outboxEnqueue && enqueueEnabled),
      };
    },
    async processVerifiedInboundFollow(params) {
      const result = await runTransactionalMutation(
        (repo) =>
          repo.recordInboundFollow({
            canonicalOrigin,
            localActorId: params.localActorId,
            localActorPreferredUsername: params.localActorPreferredUsername,
            localActorKeyId: params.localActorKeyId,
            localActorUri: params.localActorUri,
            remoteActorUri: params.remoteActorUri,
            remoteInboxUri: params.remoteInboxUri,
            remoteSharedInboxUri: params.remoteSharedInboxUri,
            followActivityUri: params.followActivityUri,
          }),
        async (resources, mutationResult) => {
          await enqueueTransitionIfPresent(resources, mutationResult);
        },
      );
      return {
        processed: Boolean(result),
        enqueued: Boolean(result?.outboxEnqueue && enqueueEnabled),
      };
    },
    async processVerifiedInboundAccept(params) {
      const result = await runTransactionalMutation((repo) =>
        repo.recordOutboundAcceptReceipt({
          canonicalOrigin,
          ...(params.localActorId ? { localActorId: params.localActorId } : {}),
          remoteActorUri: params.remoteActorUri,
          followActivityUri: params.followActivityUri,
          activityUri: params.acceptActivityUri,
        }),
      );
      return { processed: Boolean(result) };
    },
    async processVerifiedInboundUndo(params) {
      const result = await runTransactionalMutation((repo) =>
        repo.recordInboundUndoFollow({
          canonicalOrigin,
          localActorId: params.localActorId,
          localActorPreferredUsername: params.localActorPreferredUsername,
          localActorKeyId: params.localActorKeyId,
          localActorUri: params.localActorUri,
          remoteActorUri: params.remoteActorUri,
          remoteInboxUri: params.remoteInboxUri,
          remoteSharedInboxUri: params.remoteSharedInboxUri,
          undoActivityUri: params.undoActivityUri,
          embeddedFollowActivityUri: params.embeddedFollowActivityUri,
        }),
      );
      return { processed: Boolean(result) };
    },
    async listProjectOutboundSubscriptions(projectId) {
      const follows = await repository.listProjectOutboundFollows({ projectId });
      return follows.map((follow) => ({
        remoteActorAddress: follow.remoteActorUri,
        status: follow.status,
      }));
    },
    async listAcceptedFollowCollection(params) {
      const [page, totalItems] = await Promise.all([
        repository.listAcceptedFollows({
          localActorId: params.localActorId,
          direction: params.direction,
          cursor: params.cursor,
        }),
        repository.countAcceptedFollows({
          localActorId: params.localActorId,
          direction: params.direction,
        }),
      ]);
      return {
        items: page.items.map((follow) => ({ actorUri: follow.remoteActorUri })),
        nextCursor: page.nextCursor,
        totalItems,
      };
    },
    async countAcceptedFollowCollection(params) {
      return repository.countAcceptedFollows({
        localActorId: params.localActorId,
        direction: params.direction,
      });
    },
  };
}
