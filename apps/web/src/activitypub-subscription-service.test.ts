import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityPubFollowUseCases } from '@pufu-lens/activitypub';
import { ActivityPubSubscriptionError } from './activitypub-subscription-errors.ts';
import {
  followRemoteActorForProjectAdmin,
  unfollowRemoteActorForProjectAdmin,
} from './activitypub-subscription-service.ts';
import {
  validateSubscriptionProjectSlugOrThrow,
  validateSubscriptionRemoteActorAddressOrThrow,
} from './activitypub-subscription-validation.ts';

const projectId = '10000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const actorId = 'a0000000-0000-0000-0000-000000000001';

function createFollowUseCases(
  overrides?: Partial<ActivityPubFollowUseCases>,
): ActivityPubFollowUseCases {
  return {
    requestOutboundFollow: async () => ({
      follow: {
        id: 'f0000000-0000-0000-0000-000000000001',
        direction: 'outbound',
        localActorId: actorId,
        remoteActorUri: 'https://remote.example/users/alice',
        remoteInboxUri: 'https://remote.example/users/alice/inbox',
        remoteSharedInboxUri: null,
        followActivityUri: 'https://lens.test/activitypub/activities/follow/test',
        status: 'pending',
        createdAt: new Date(),
        acceptedAt: null,
        undoneAt: null,
        updatedAt: new Date(),
      },
      enqueued: true,
    }),
    requestOutboundUndo: async () => ({
      follow: {
        id: 'f0000000-0000-0000-0000-000000000001',
        direction: 'outbound',
        localActorId: actorId,
        remoteActorUri: 'https://remote.example/users/alice',
        remoteInboxUri: 'https://remote.example/users/alice/inbox',
        remoteSharedInboxUri: null,
        followActivityUri: 'https://lens.test/activitypub/activities/follow/test',
        status: 'undone',
        createdAt: new Date(),
        acceptedAt: null,
        undoneAt: new Date(),
        updatedAt: new Date(),
      },
      enqueued: true,
    }),
    processVerifiedInboundFollow: async () => ({ processed: false, enqueued: false }),
    processVerifiedInboundAccept: async () => ({ processed: false }),
    processVerifiedInboundUndo: async () => ({ processed: false }),
    listProjectOutboundSubscriptions: async () => [],
    listAcceptedFollowCollection: async () => ({ items: [], totalItems: 0 }),
    countAcceptedFollowCollection: async () => 0,
    resolveRemoteActor: async () => ({
      actorUri: 'https://remote.example/users/alice',
      inboxUri: 'https://remote.example/users/alice/inbox',
      sharedInboxUri: null,
    }),
    getRepository: () => {
      throw new Error('not implemented');
    },
    ...overrides,
  };
}

test('validateSubscriptionProjectSlugOrThrow rejects invalid slug', () => {
  assert.throws(() => validateSubscriptionProjectSlugOrThrow('a'), ActivityPubSubscriptionError);
});

test('validateSubscriptionRemoteActorAddressOrThrow rejects malformed addresses', () => {
  assert.throws(
    () => validateSubscriptionRemoteActorAddressOrThrow(''),
    ActivityPubSubscriptionError,
  );
  assert.throws(
    () => validateSubscriptionRemoteActorAddressOrThrow('not-a-handle'),
    ActivityPubSubscriptionError,
  );
  validateSubscriptionRemoteActorAddressOrThrow('acct:alice@remote.example');
  validateSubscriptionRemoteActorAddressOrThrow('https://remote.example/users/alice');
});

test('followRemoteActorForProjectAdmin rejects cross-project admin access', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: 'other-project',
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
  });
  await assert.rejects(
    () =>
      followRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorAddress: 'acct:alice@remote.example',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) => error instanceof ActivityPubSubscriptionError && error.code === 'forbidden',
  );
});

test('followRemoteActorForProjectAdmin rejects non-admin members', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'member',
    visibility: 'public',
  });
  await assert.rejects(
    () =>
      followRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorAddress: 'acct:alice@remote.example',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) => error instanceof ActivityPubSubscriptionError && error.code === 'forbidden',
  );
});

test('followRemoteActorForProjectAdmin rejects disabled federation actor', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
    actorEnabled: false,
  });
  await assert.rejects(
    () =>
      followRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorAddress: 'acct:alice@remote.example',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) =>
      error instanceof ActivityPubSubscriptionError && error.code === 'federation_disabled',
  );
});

test('followRemoteActorForProjectAdmin maps resolver failures to safe messages', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
  });
  await assert.rejects(
    () =>
      followRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorAddress: 'acct:alice@remote.example',
        followUseCases: createFollowUseCases({
          requestOutboundFollow: async () => {
            throw new Error('SELECT * FROM secrets WHERE token = x');
          },
        }),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) => {
      if (!(error instanceof ActivityPubSubscriptionError)) {
        return false;
      }
      return (
        error.code === 'remote_resolution_failed' &&
        error.message === 'Unable to update ActivityPub subscription. Try again later.'
      );
    },
  );
});

test('followRemoteActorForProjectAdmin rejects malformed project actor SQL row', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
    malformedActorRow: { id: actorId, enabled: 'yes', preferred_username: projectSlug },
  });
  await assert.rejects(
    () =>
      followRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorAddress: 'acct:alice@remote.example',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) => error instanceof ActivityPubSubscriptionError,
  );
});

test('followRemoteActorForProjectAdmin maps actor lookup SQL failures to generic message', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
    actorSqlError: 'SELECT * FROM secrets WHERE token = leaked',
  });
  await assert.rejects(
    () =>
      followRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorAddress: 'acct:alice@remote.example',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) => {
      if (!(error instanceof ActivityPubSubscriptionError)) {
        return false;
      }
      return (
        error.message === 'Unable to update ActivityPub subscription. Try again later.' &&
        !error.message.includes('secrets') &&
        !error.message.includes('leaked')
      );
    },
  );
});

test('unfollowRemoteActorForProjectAdmin rejects malformed outbound follow SQL row', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
    outboundFollow: {
      remote_actor_uri: 'https://remote.example/users/alice',
      remote_inbox_uri: 'https://remote.example/users/alice/inbox',
      remote_shared_inbox_uri: null,
    },
    malformedOutboundFollowRow: {
      remote_actor_uri: 'https://remote.example/users/alice',
      remote_inbox_uri: 123,
      remote_shared_inbox_uri: null,
    },
  });
  await assert.rejects(
    () =>
      unfollowRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorUri: 'https://remote.example/users/alice',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) => error instanceof ActivityPubSubscriptionError,
  );
});

test('unfollowRemoteActorForProjectAdmin rejects missing subscription', async () => {
  const sql = createAuthSql({
    id: projectId,
    slug: projectSlug,
    appRole: 'member',
    projectRole: 'admin',
    visibility: 'public',
    outboundFollow: null,
  });
  await assert.rejects(
    () =>
      unfollowRemoteActorForProjectAdmin(sql, {
        userId: 'user-1',
        projectSlug,
        remoteActorUri: 'https://remote.example/users/missing',
        followUseCases: createFollowUseCases(),
        canonicalOrigin: 'https://lens.test',
      }),
    (error: unknown) =>
      error instanceof ActivityPubSubscriptionError && error.code === 'subscription_not_found',
  );
});

function createAuthSql(access?: {
  id: string;
  slug: string;
  appRole: 'admin' | 'member';
  projectRole: 'admin' | 'member' | null;
  visibility: 'public' | 'private';
  actorEnabled?: boolean;
  actorSqlError?: string;
  malformedActorRow?: Record<string, unknown>;
  outboundFollow?: {
    remote_actor_uri: string;
    remote_inbox_uri: string;
    remote_shared_inbox_uri: string | null;
  } | null;
  malformedOutboundFollowRow?: Record<string, unknown>;
}) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = String.raw({ raw: strings }, ...values);
    if (query.includes('FROM public.projects p')) {
      if (!access) {
        return [];
      }
      return [
        {
          id: access.id,
          slug: access.slug,
          name: access.slug,
          description: null,
          graphName: `graph_${access.slug.replaceAll('-', '_')}`,
          settings: {},
          visibility: access.visibility,
          appRole: access.appRole,
          projectRole: access.projectRole,
        },
      ];
    }
    if (query.includes('FROM public.activitypub_actors')) {
      if (!access) {
        return [];
      }
      if (access.actorSqlError) {
        throw new Error(access.actorSqlError);
      }
      if (access.malformedActorRow) {
        return [access.malformedActorRow];
      }
      return [
        {
          id: actorId,
          enabled: access.actorEnabled ?? true,
          preferred_username: access.slug,
        },
      ];
    }
    if (query.includes('FROM public.activitypub_follows')) {
      if (!access?.outboundFollow) {
        return [];
      }
      if (access.malformedOutboundFollowRow) {
        return [access.malformedOutboundFollowRow];
      }
      return [access.outboundFollow];
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  }) as never;
}
