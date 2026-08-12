import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  buildDeterministicAcceptActivityUri,
  buildDeterministicUndoActivityUri,
  buildFollowActivityReceiptPayload,
  buildOutboundFollowActivityUri,
  decodeFollowCollectionCursor,
  encodeFollowCollectionCursor,
  type FollowTransitionResult,
  getFollowCollectionPageSize,
  normalizeRemoteActorUri,
} from './follow-model.ts';
import {
  type ActivityPubFollow,
  type ActivityPubFollowDirection,
  parseActivityPubFollowRow,
  parseOptionalRow,
  parseRequiredRow,
} from './schema.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/** Repository boundary for ActivityPub follow persistence and transitions. */
export type ActivityPubFollowRepository = {
  runInTransaction<T>(
    callback: (repository: ActivityPubFollowRepository) => Promise<T>,
  ): Promise<T>;
  requestOutboundFollow(input: OutboundFollowInput): Promise<FollowTransitionResult>;
  recordOutboundAcceptReceipt(
    input: OutboundAcceptReceiptInput,
  ): Promise<FollowTransitionResult | null>;
  requestOutboundUndo(input: OutboundUndoInput): Promise<FollowTransitionResult | null>;
  recordInboundFollow(input: InboundFollowInput): Promise<FollowTransitionResult | null>;
  recordInboundUndoFollow(input: InboundUndoFollowInput): Promise<FollowTransitionResult | null>;
  listAcceptedFollows(input: ListAcceptedFollowsInput): Promise<AcceptedFollowPage>;
  countAcceptedFollows(input: CountAcceptedFollowsInput): Promise<number>;
  listProjectOutboundFollows(input: ListProjectOutboundFollowsInput): Promise<ActivityPubFollow[]>;
};

export type OutboundFollowInput = {
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
};

export type OutboundAcceptReceiptInput = {
  canonicalOrigin: string;
  localActorId?: string;
  remoteActorUri: string;
  followActivityUri: string;
  activityUri: string;
};

export type OutboundUndoInput = {
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
};

export type InboundFollowInput = {
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  localActorUri: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
  followActivityUri: string;
};

export type InboundUndoFollowInput = {
  canonicalOrigin: string;
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

export type ListAcceptedFollowsInput = {
  localActorId: string;
  direction: ActivityPubFollowDirection;
  cursor?: string;
};

export type AcceptedFollowPage = {
  items: ActivityPubFollow[];
  nextCursor?: string;
};

export type CountAcceptedFollowsInput = {
  localActorId: string;
  direction: ActivityPubFollowDirection;
};

export type ListProjectOutboundFollowsInput = {
  projectId: string;
};

type RepositoryExecutorConfig =
  | { kind: 'root'; sql: postgres.Sql }
  | { kind: 'transaction'; sql: postgres.TransactionSql };

/** Creates the PostgreSQL-backed ActivityPub follow repository. */
export function createPostgresActivityPubFollowRepository(input: {
  sql: postgres.Sql;
}): ActivityPubFollowRepository {
  return createRepositoryExecutor({ kind: 'root', sql: input.sql });
}

/** Creates a transaction-bound follow repository for rollback-safe integration tests. */
export function createPostgresActivityPubFollowTransactionRepository(input: {
  sql: postgres.TransactionSql;
}): ActivityPubFollowRepository {
  return createRepositoryExecutor({ kind: 'transaction', sql: input.sql });
}

function createRepositoryExecutor(config: RepositoryExecutorConfig): ActivityPubFollowRepository {
  const runMutation = <T>(mutation: (sql: SqlExecutor) => Promise<T>): Promise<T> => {
    if (config.kind === 'transaction') {
      return mutation(config.sql);
    }
    return config.sql.begin((tx) => mutation(tx)) as Promise<T>;
  };

  return {
    runInTransaction<T>(callback: (repository: ActivityPubFollowRepository) => Promise<T>) {
      if (config.kind === 'transaction') {
        return callback(createRepositoryExecutor(config));
      }
      return config.sql.begin(async (tx) =>
        callback(createRepositoryExecutor({ kind: 'transaction', sql: tx })),
      ) as Promise<T>;
    },
    requestOutboundFollow: (params) =>
      runMutation((sql) => requestOutboundFollow({ sql, ...params })),
    recordOutboundAcceptReceipt: (params) =>
      runMutation((sql) => recordOutboundAcceptReceipt({ sql, ...params })),
    requestOutboundUndo: (params) => runMutation((sql) => requestOutboundUndo({ sql, ...params })),
    recordInboundFollow: (params) => runMutation((sql) => recordInboundFollow({ sql, ...params })),
    recordInboundUndoFollow: (params) =>
      runMutation((sql) => recordInboundUndoFollow({ sql, ...params })),
    listAcceptedFollows: (params) => listAcceptedFollows({ sql: config.sql, ...params }),
    countAcceptedFollows: (params) => countAcceptedFollows({ sql: config.sql, ...params }),
    listProjectOutboundFollows: (params) =>
      listProjectOutboundFollows({ sql: config.sql, ...params }),
  };
}

async function requestOutboundFollow(input: {
  sql: SqlExecutor;
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
}): Promise<FollowTransitionResult> {
  const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
  let existing = await lockFollowRow({
    sql: input.sql,
    direction: 'outbound',
    localActorId: input.localActorId,
    remoteActorUri: normalizedRemote,
  });

  let follow: ActivityPubFollow;
  let followActivityUri: string;

  if (!existing) {
    followActivityUri = buildOutboundFollowActivityUri(input.canonicalOrigin);
    const rows = (await input.sql`
      INSERT INTO public.activitypub_follows (
        direction,
        local_actor_id,
        remote_actor_uri,
        remote_inbox_uri,
        remote_shared_inbox_uri,
        follow_activity_uri,
        status,
        created_at,
        accepted_at,
        undone_at,
        updated_at
      )
      VALUES (
        'outbound',
        ${input.localActorId}::uuid,
        ${normalizedRemote},
        ${input.remoteInboxUri},
        ${input.remoteSharedInboxUri},
        ${followActivityUri},
        'pending',
        now(),
        NULL,
        NULL,
        now()
      )
      ON CONFLICT ON CONSTRAINT activitypub_follows_direction_local_remote_key DO NOTHING
      RETURNING *
    `) as readonly unknown[];
    if (rows.length > 0) {
      follow = parseRequiredRow(rows, parseActivityPubFollowRow);
    } else {
      const locked = await lockFollowRow({
        sql: input.sql,
        direction: 'outbound',
        localActorId: input.localActorId,
        remoteActorUri: normalizedRemote,
      });
      if (!locked) {
        throw new Error('follow row missing after insert conflict');
      }
      existing = locked;
      follow = locked;
      followActivityUri = locked.followActivityUri;
    }
  } else if (existing.status === 'pending' || existing.status === 'accepted') {
    follow = existing;
    followActivityUri = existing.followActivityUri;
  } else {
    followActivityUri = buildOutboundFollowActivityUri(input.canonicalOrigin);
    const rows = (await input.sql`
      UPDATE public.activitypub_follows
      SET follow_activity_uri = ${followActivityUri},
          remote_inbox_uri = ${input.remoteInboxUri},
          remote_shared_inbox_uri = ${input.remoteSharedInboxUri},
          status = 'pending',
          accepted_at = NULL,
          undone_at = NULL,
          updated_at = now()
      WHERE id = ${existing.id}::uuid
      RETURNING *
    `) as readonly unknown[];
    follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  }

  const inserted = await insertActivityReceipt({
    sql: input.sql,
    activityUri: followActivityUri,
    objectUri: normalizedRemote,
    activityType: 'Follow',
    actorUri: `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(input.localActorPreferredUsername)}`,
    localActorId: input.localActorId,
    direction: 'outbound',
    remoteActorUri: normalizedRemote,
  });

  if (!inserted) {
    return { follow };
  }

  const sharedInbox = Boolean(input.remoteSharedInboxUri);
  const recipientInbox = sharedInbox
    ? (input.remoteSharedInboxUri as string)
    : input.remoteInboxUri;

  return {
    follow,
    outboxEnqueue: buildOutboundEnqueue({
      canonicalOrigin: input.canonicalOrigin,
      localActorPreferredUsername: input.localActorPreferredUsername,
      localActorKeyId: input.localActorKeyId,
      activityUri: followActivityUri,
      activityType: 'Follow',
      recipientInbox,
      sharedInbox,
      orderingKey: followActivityUri,
      objectUri: normalizedRemote,
    }),
  };
}

async function recordOutboundAcceptReceipt(input: {
  sql: SqlExecutor;
  canonicalOrigin: string;
  localActorId?: string;
  remoteActorUri: string;
  followActivityUri: string;
  activityUri: string;
}): Promise<FollowTransitionResult | null> {
  const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
  const existingRows = (await input.sql`
    SELECT *
    FROM public.activitypub_follows
    WHERE direction = 'outbound'
      AND remote_actor_uri = ${normalizedRemote}
      AND follow_activity_uri = ${input.followActivityUri}
    FOR UPDATE
  `) as readonly unknown[];
  const existing = parseOptionalRow(existingRows, parseActivityPubFollowRow);
  if (!existing || (input.localActorId && existing.localActorId !== input.localActorId)) {
    return null;
  }
  const inserted = await insertActivityReceipt({
    sql: input.sql,
    activityUri: input.activityUri,
    objectUri: input.followActivityUri,
    activityType: 'Accept',
    actorUri: normalizedRemote,
    localActorId: existing.localActorId,
    direction: 'inbound',
    remoteActorUri: normalizedRemote,
  });
  if (!inserted) {
    return null;
  }

  if (existing.status === 'undone' || existing.status === 'rejected') {
    return { follow: existing };
  }
  if (existing.status === 'accepted') {
    return { follow: existing };
  }

  const rows = (await input.sql`
    UPDATE public.activitypub_follows
    SET status = 'accepted',
        accepted_at = now(),
        updated_at = now()
    WHERE id = ${existing.id}::uuid
    RETURNING *
  `) as readonly unknown[];
  const follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  return { follow };
}

async function requestOutboundUndo(input: {
  sql: SqlExecutor;
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
}): Promise<FollowTransitionResult | null> {
  const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
  const existing = await lockFollowRow({
    sql: input.sql,
    direction: 'outbound',
    localActorId: input.localActorId,
    remoteActorUri: normalizedRemote,
  });
  if (!existing) {
    return null;
  }
  if (existing.status === 'rejected') {
    return { follow: existing };
  }

  const undoActivityUri = buildDeterministicUndoActivityUri(
    input.canonicalOrigin,
    existing.followActivityUri,
  );

  let follow = existing;
  if (existing.status === 'pending' || existing.status === 'accepted') {
    const rows = (await input.sql`
      UPDATE public.activitypub_follows
      SET status = 'undone',
          undone_at = now(),
          updated_at = now()
      WHERE id = ${existing.id}::uuid
      RETURNING *
    `) as readonly unknown[];
    follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  }

  const inserted = await insertActivityReceipt({
    sql: input.sql,
    activityUri: undoActivityUri,
    objectUri: existing.followActivityUri,
    activityType: 'Undo',
    actorUri: `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(input.localActorPreferredUsername)}`,
    localActorId: input.localActorId,
    direction: 'outbound',
    remoteActorUri: normalizedRemote,
  });
  if (!inserted) {
    return { follow };
  }

  const sharedInbox = Boolean(input.remoteSharedInboxUri);
  const recipientInbox = sharedInbox
    ? (input.remoteSharedInboxUri as string)
    : input.remoteInboxUri;

  return {
    follow,
    outboxEnqueue: buildOutboundEnqueue({
      canonicalOrigin: input.canonicalOrigin,
      localActorPreferredUsername: input.localActorPreferredUsername,
      localActorKeyId: input.localActorKeyId,
      activityUri: undoActivityUri,
      activityType: 'Undo',
      recipientInbox,
      sharedInbox,
      orderingKey: existing.followActivityUri,
      objectUri: normalizedRemote,
      embeddedFollowUri: existing.followActivityUri,
      localActorUri: `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(input.localActorPreferredUsername)}`,
      remoteActorUri: normalizedRemote,
    }),
  };
}

async function recordInboundFollow(input: {
  sql: SqlExecutor;
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  localActorUri: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
  followActivityUri: string;
}): Promise<FollowTransitionResult | null> {
  const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);

  const inserted = await insertActivityReceipt({
    sql: input.sql,
    activityUri: input.followActivityUri,
    objectUri: input.localActorUri,
    activityType: 'Follow',
    actorUri: normalizedRemote,
    localActorId: input.localActorId,
    direction: 'inbound',
    remoteActorUri: normalizedRemote,
  });
  if (!inserted) {
    return null;
  }

  const existing = await lockFollowRow({
    sql: input.sql,
    direction: 'inbound',
    localActorId: input.localActorId,
    remoteActorUri: normalizedRemote,
  });

  if (existing?.status === 'undone' && existing.followActivityUri === input.followActivityUri) {
    return { follow: existing };
  }

  if (
    existing &&
    existing.followActivityUri === input.followActivityUri &&
    existing.status === 'accepted'
  ) {
    return { follow: existing };
  }

  let follow: ActivityPubFollow;
  if (!existing) {
    const rows = (await input.sql`
      INSERT INTO public.activitypub_follows (
        direction,
        local_actor_id,
        remote_actor_uri,
        remote_inbox_uri,
        remote_shared_inbox_uri,
        follow_activity_uri,
        status,
        created_at,
        accepted_at,
        undone_at,
        updated_at
      )
      VALUES (
        'inbound',
        ${input.localActorId}::uuid,
        ${normalizedRemote},
        ${input.remoteInboxUri},
        ${input.remoteSharedInboxUri},
        ${input.followActivityUri},
        'accepted',
        now(),
        now(),
        NULL,
        now()
      )
      RETURNING *
    `) as readonly unknown[];
    follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  } else {
    const rows = (await input.sql`
      UPDATE public.activitypub_follows
      SET follow_activity_uri = ${input.followActivityUri},
          remote_inbox_uri = ${input.remoteInboxUri},
          remote_shared_inbox_uri = ${input.remoteSharedInboxUri},
          status = 'accepted',
          accepted_at = now(),
          undone_at = NULL,
          updated_at = now()
      WHERE id = ${existing.id}::uuid
      RETURNING *
    `) as readonly unknown[];
    follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  }

  const acceptActivityUri = buildDeterministicAcceptActivityUri(
    input.canonicalOrigin,
    input.followActivityUri,
  );

  const sharedInbox = Boolean(input.remoteSharedInboxUri);
  const recipientInbox = sharedInbox
    ? (input.remoteSharedInboxUri as string)
    : input.remoteInboxUri;

  return {
    follow,
    outboxEnqueue: buildOutboundEnqueue({
      canonicalOrigin: input.canonicalOrigin,
      localActorPreferredUsername: input.localActorPreferredUsername,
      localActorKeyId: input.localActorKeyId,
      activityUri: acceptActivityUri,
      activityType: 'Accept',
      recipientInbox,
      sharedInbox,
      orderingKey: acceptActivityUri,
      objectUri: input.followActivityUri,
      localActorUri: input.localActorUri,
      remoteActorUri: normalizedRemote,
    }),
  };
}

async function recordInboundUndoFollow(input: {
  sql: SqlExecutor;
  canonicalOrigin: string;
  localActorId: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  localActorUri: string;
  remoteActorUri: string;
  remoteInboxUri: string;
  remoteSharedInboxUri: string | null;
  undoActivityUri: string;
  embeddedFollowActivityUri: string;
}): Promise<FollowTransitionResult | null> {
  const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);

  const inserted = await insertActivityReceipt({
    sql: input.sql,
    activityUri: input.undoActivityUri,
    objectUri: input.embeddedFollowActivityUri,
    activityType: 'Undo',
    actorUri: normalizedRemote,
    localActorId: input.localActorId,
    direction: 'inbound',
    remoteActorUri: normalizedRemote,
  });
  if (!inserted) {
    return null;
  }

  const existing = await lockFollowRow({
    sql: input.sql,
    direction: 'inbound',
    localActorId: input.localActorId,
    remoteActorUri: normalizedRemote,
  });

  let follow: ActivityPubFollow;
  if (!existing) {
    const rows = (await input.sql`
      INSERT INTO public.activitypub_follows (
        direction,
        local_actor_id,
        remote_actor_uri,
        remote_inbox_uri,
        remote_shared_inbox_uri,
        follow_activity_uri,
        status,
        created_at,
        accepted_at,
        undone_at,
        updated_at
      )
      VALUES (
        'inbound',
        ${input.localActorId}::uuid,
        ${normalizedRemote},
        ${input.remoteInboxUri},
        ${input.remoteSharedInboxUri},
        ${input.embeddedFollowActivityUri},
        'undone',
        now(),
        NULL,
        now(),
        now()
      )
      RETURNING *
    `) as readonly unknown[];
    follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  } else if (existing.status !== 'undone') {
    if (
      existing.status === 'accepted' &&
      existing.followActivityUri !== input.embeddedFollowActivityUri
    ) {
      return { follow: existing };
    }
    const rows = (await input.sql`
      UPDATE public.activitypub_follows
      SET status = 'undone',
          undone_at = now(),
          updated_at = now()
      WHERE id = ${existing.id}::uuid
      RETURNING *
    `) as readonly unknown[];
    follow = parseRequiredRow(rows, parseActivityPubFollowRow);
  } else {
    follow = existing;
  }

  return { follow };
}

async function listAcceptedFollows(input: {
  sql: SqlExecutor;
  localActorId: string;
  direction: ActivityPubFollowDirection;
  cursor?: string;
}): Promise<AcceptedFollowPage> {
  const pageSize = getFollowCollectionPageSize();
  let rows: readonly unknown[];

  if (input.cursor) {
    const decoded = decodeFollowCollectionCursor(input.cursor);
    rows = (await input.sql`
      SELECT *
      FROM public.activitypub_follows
      WHERE local_actor_id = ${input.localActorId}::uuid
        AND direction = ${input.direction}
        AND status = 'accepted'
        AND (created_at, id) > (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)
      ORDER BY created_at ASC, id ASC
      LIMIT ${pageSize + 1}
    `) as readonly unknown[];
  } else {
    rows = (await input.sql`
      SELECT *
      FROM public.activitypub_follows
      WHERE local_actor_id = ${input.localActorId}::uuid
        AND direction = ${input.direction}
        AND status = 'accepted'
      ORDER BY created_at ASC, id ASC
      LIMIT ${pageSize + 1}
    `) as readonly unknown[];
  }

  const follows = rows.map((row) => parseActivityPubFollowRow(row));
  const hasMore = follows.length > pageSize;
  const items = hasMore ? follows.slice(0, pageSize) : follows;
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeFollowCollectionCursor({ createdAt: last.createdAt, id: last.id })
        : undefined,
  };
}

async function countAcceptedFollows(input: {
  sql: SqlExecutor;
  localActorId: string;
  direction: ActivityPubFollowDirection;
}): Promise<number> {
  const rows = (await input.sql`
    SELECT COUNT(*)::text AS count
    FROM public.activitypub_follows
    WHERE local_actor_id = ${input.localActorId}::uuid
      AND direction = ${input.direction}
      AND status = 'accepted'
  `) as readonly unknown[];
  const row = rows[0];
  if (!row || typeof row !== 'object') {
    return 0;
  }
  const count = (row as Record<string, unknown>).count;
  return typeof count === 'string' ? Number(count) : 0;
}

async function listProjectOutboundFollows(input: {
  sql: SqlExecutor;
  projectId: string;
}): Promise<ActivityPubFollow[]> {
  const rows = (await input.sql`
    SELECT f.*
    FROM public.activitypub_follows f
    JOIN public.activitypub_actors a ON a.id = f.local_actor_id
    WHERE a.project_id = ${input.projectId}::uuid
      AND f.direction = 'outbound'
    ORDER BY f.created_at ASC, f.id ASC
  `) as readonly unknown[];
  return rows.map((row) => parseActivityPubFollowRow(row));
}

async function lockFollowRow(input: {
  sql: SqlExecutor;
  direction: ActivityPubFollowDirection;
  localActorId: string;
  remoteActorUri: string;
}): Promise<ActivityPubFollow | undefined> {
  const rows = (await input.sql`
    SELECT *
    FROM public.activitypub_follows
    WHERE direction = ${input.direction}
      AND local_actor_id = ${input.localActorId}::uuid
      AND remote_actor_uri = ${input.remoteActorUri}
    FOR UPDATE
  `) as readonly unknown[];
  return parseOptionalRow(rows, parseActivityPubFollowRow);
}

async function insertActivityReceipt(input: {
  sql: SqlExecutor;
  activityUri: string;
  objectUri: string | null;
  activityType: string;
  actorUri: string;
  localActorId: string | null;
  direction: ActivityPubFollowDirection | 'inbound' | 'outbound';
  remoteActorUri: string | null;
}): Promise<boolean> {
  const payload = buildFollowActivityReceiptPayload({
    direction: input.direction,
    activityType: input.activityType,
    localActorId: input.localActorId,
    remoteActorUri: input.remoteActorUri,
  });
  const rows = (await input.sql`
    INSERT INTO public.activitypub_activities (
      id,
      activity_uri,
      object_uri,
      activity_type,
      actor_uri,
      local_actor_id,
      direction,
      payload_json,
      processing_status,
      available_at,
      occurred_at
    )
    VALUES (
      ${randomUUID()}::uuid,
      ${input.activityUri},
      ${input.objectUri},
      ${input.activityType},
      ${input.actorUri},
      ${input.localActorId ? input.localActorId : null}::uuid,
      ${input.direction},
      ${input.sql.json(payload as never)},
      'processed',
      now(),
      now()
    )
    ON CONFLICT (activity_uri) DO NOTHING
    RETURNING id
  `) as readonly unknown[];
  return rows.length > 0;
}

function buildOutboundEnqueue(input: {
  canonicalOrigin: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  activityUri: string;
  activityType: string;
  recipientInbox: string;
  sharedInbox: boolean;
  orderingKey: string;
  objectUri: string;
  embeddedFollowUri?: string;
  localActorUri?: string;
  remoteActorUri?: string;
}): FollowTransitionResult['outboxEnqueue'] {
  const actorUri = `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(input.localActorPreferredUsername)}`;
  const activityJsonLd =
    input.activityType === 'Undo'
      ? {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: input.activityUri,
          type: 'Undo',
          actor: actorUri,
          object: {
            id: input.embeddedFollowUri ?? input.objectUri,
            type: 'Follow',
            actor: actorUri,
            object: input.remoteActorUri ?? input.objectUri,
          },
        }
      : input.activityType === 'Accept'
        ? {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id: input.activityUri,
            type: 'Accept',
            actor: actorUri,
            object: {
              id: input.objectUri,
              type: 'Follow',
              actor: input.remoteActorUri ?? input.objectUri,
              object: input.localActorUri ?? actorUri,
            },
          }
        : {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id: input.activityUri,
            type: 'Follow',
            actor: actorUri,
            object: input.objectUri,
          };

  return {
    activityUri: input.activityUri,
    activityType: input.activityType,
    recipientInbox: input.recipientInbox,
    sharedInbox: input.sharedInbox,
    orderingKey: input.orderingKey,
    actorKeyId: input.localActorKeyId,
    localActorPreferredUsername: input.localActorPreferredUsername,
    activityJsonLd,
  };
}
