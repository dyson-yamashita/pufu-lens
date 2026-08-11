import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { normalizeRemoteActorUri } from './follow-model.ts';
import {
  type FederatedReport,
  parseActivityPubActivityRow,
  parseFederatedReportRow,
  parseOptionalRow,
  readSqlRows,
  sqlInsertReturnedRow,
} from './schema.ts';

const LIST_BY_PROJECT_LIMIT = 100;

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/** Mapped inbound report input normalized from Create/Announce activities. */
export type MappedInboundReportInput = {
  readonly activityUri: string;
  readonly activityType: 'Create' | 'Announce';
  readonly sourceActorUri: string;
  readonly canonicalRemoteObjectUri: string;
  readonly objectType: 'article';
  readonly title: string;
  readonly summaryHtmlSanitized: string;
  readonly originalUrl: string;
  readonly publishedAt: Date | null;
  readonly remoteUpdatedAt: Date | null;
};

/** Locked follow row used when saving inbound federated reports. */
export type InboundReportFollowLockRow = {
  readonly followId: string;
  readonly projectId: string;
};

/** Repository boundary for inbound federated report persistence. */
export type FederatedReportRepository = {
  saveInboundReport(input: SaveInboundReportInput): Promise<{ saved: boolean }>;
  listByProject(input: ListFederatedReportsByProjectInput): Promise<FederatedReport[]>;
};

export type SaveInboundReportInput = {
  readonly activityUri: string;
  readonly activityType: string;
  readonly objectType: string;
  readonly sourceActorUri: string;
  readonly mapped: MappedInboundReportInput;
  readonly recipientPreferredUsername: string | null;
};

export type ListFederatedReportsByProjectInput = {
  readonly projectId: string;
};

type RepositoryExecutorConfig =
  | { kind: 'root'; sql: postgres.Sql }
  | { kind: 'transaction'; sql: postgres.TransactionSql };

type InboundActivityReceiptState = 'created' | 'matched' | 'rejected';

/** Parses a locked follow row used for inbound federated report persistence. */
export function parseInboundReportFollowLockRow(row: unknown): InboundReportFollowLockRow {
  if (!isRecord(row)) {
    throw new Error('Invalid inbound report follow lock row.');
  }
  return {
    followId: parseRequiredString(row.id, 'id'),
    projectId: parseRequiredString(row.project_id, 'project_id'),
  };
}

/** Creates the PostgreSQL-backed federated report repository. */
export function createPostgresFederatedReportRepository(input: {
  sql: postgres.Sql;
}): FederatedReportRepository {
  return createRepositoryExecutor({ kind: 'root', sql: input.sql });
}

function createRepositoryExecutor(config: RepositoryExecutorConfig): FederatedReportRepository {
  return {
    saveInboundReport: (params) => {
      if (config.kind === 'transaction') {
        return saveInboundReport({ sql: config.sql, ...params });
      }
      return config.sql.begin((tx) => saveInboundReport({ sql: tx, ...params }));
    },
    listByProject: (params) => listByProject({ sql: config.sql, ...params }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid inbound report row field: ${fieldName}`);
  }
  return value;
}

async function loadLockedFollowRows(input: {
  sql: SqlExecutor;
  sourceActorUri: string;
  recipientPreferredUsername: string | null;
}): Promise<InboundReportFollowLockRow[]> {
  const rows = readSqlRows(
    await input.sql`
    SELECT f.id, a.project_id
    FROM public.activitypub_follows f
    INNER JOIN public.activitypub_actors a ON a.id = f.local_actor_id
    WHERE f.direction = 'outbound'
      AND f.remote_actor_uri = ${input.sourceActorUri}
      AND f.status = 'accepted'
      AND f.accepted_at IS NOT NULL
      AND f.undone_at IS NULL
      AND a.kind = 'project'
      AND a.enabled = true
      AND a.project_id IS NOT NULL
      AND (
        ${input.recipientPreferredUsername}::text IS NULL
        OR a.preferred_username = ${input.recipientPreferredUsername}
      )
    FOR UPDATE OF f
  `,
  );
  return rows.map((row) => parseInboundReportFollowLockRow(row));
}

async function ensureInboundActivityReceipt(input: {
  sql: SqlExecutor;
  activityUri: string;
  activityType: string;
  objectType: string;
  sourceActorUri: string;
  canonicalObjectUri: string;
}): Promise<InboundActivityReceiptState> {
  const receiptPayload = {
    activityType: input.activityType,
    objectType: input.objectType,
  };

  const activityInsert = readSqlRows(
    await input.sql`
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
      attempt_count,
      occurred_at,
      processed_at
    )
    VALUES (
      ${randomUUID()}::uuid,
      ${input.activityUri},
      ${input.canonicalObjectUri},
      ${input.activityType},
      ${input.sourceActorUri},
      NULL,
      'inbound',
      ${input.sql.json(receiptPayload)},
      'processed',
      now(),
      0,
      now(),
      now()
    )
    ON CONFLICT (activity_uri) DO NOTHING
    RETURNING id
  `,
  );

  if (sqlInsertReturnedRow(activityInsert)) {
    return 'created';
  }

  const existingRows = readSqlRows(
    await input.sql`
    SELECT
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
      attempt_count,
      worker_token,
      lease_expires_at,
      occurred_at,
      processed_at
    FROM public.activitypub_activities
    WHERE activity_uri = ${input.activityUri}
  `,
  );

  const existing = parseOptionalRow(existingRows, parseActivityPubActivityRow);
  if (!existing) {
    return 'rejected';
  }

  if (
    existing.direction !== 'inbound' ||
    existing.activityType !== input.activityType ||
    normalizeRemoteActorUri(existing.actorUri) !== normalizeRemoteActorUri(input.sourceActorUri) ||
    existing.objectUri !== input.canonicalObjectUri
  ) {
    return 'rejected';
  }

  return 'matched';
}

/**
 * Saves an inbound federated report for each matching accepted outbound follow.
 * Reuses an existing activity receipt when metadata matches so shared/personal redelivery can fan in.
 */
async function saveInboundReport(input: {
  sql: SqlExecutor;
  activityUri: string;
  activityType: string;
  objectType: string;
  sourceActorUri: string;
  mapped: MappedInboundReportInput;
  recipientPreferredUsername: string | null;
}): Promise<{ saved: boolean }> {
  const followRows = await loadLockedFollowRows({
    sql: input.sql,
    sourceActorUri: input.sourceActorUri,
    recipientPreferredUsername: input.recipientPreferredUsername,
  });

  if (followRows.length === 0) {
    return { saved: false };
  }

  const receiptState = await ensureInboundActivityReceipt({
    sql: input.sql,
    activityUri: input.activityUri,
    activityType: input.activityType,
    objectType: input.objectType,
    sourceActorUri: input.sourceActorUri,
    canonicalObjectUri: input.mapped.canonicalRemoteObjectUri,
  });

  if (receiptState === 'rejected') {
    return { saved: false };
  }

  let saved = false;
  for (const follow of followRows) {
    const insertResult = readSqlRows(
      await input.sql`
      INSERT INTO public.federated_reports (
        id,
        project_id,
        source_follow_id,
        remote_object_uri,
        remote_activity_uri,
        remote_actor_uri,
        object_type,
        title,
        summary_html_sanitized,
        original_url,
        published_at,
        remote_updated_at,
        received_at
      )
      VALUES (
        ${randomUUID()}::uuid,
        ${follow.projectId}::uuid,
        ${follow.followId}::uuid,
        ${input.mapped.canonicalRemoteObjectUri},
        ${input.mapped.activityUri},
        ${input.mapped.sourceActorUri},
        ${input.mapped.objectType},
        ${input.mapped.title},
        ${input.mapped.summaryHtmlSanitized},
        ${input.mapped.originalUrl},
        ${input.mapped.publishedAt},
        ${input.mapped.remoteUpdatedAt},
        now()
      )
      ON CONFLICT (project_id, remote_object_uri) DO NOTHING
      RETURNING id
    `,
    );
    if (sqlInsertReturnedRow(insertResult)) {
      saved = true;
    }
  }

  return { saved };
}

/** Lists federated reports for a project in deterministic published/received order. */
async function listByProject(input: {
  sql: SqlExecutor;
  projectId: string;
}): Promise<FederatedReport[]> {
  const rows = readSqlRows(
    await input.sql`
    SELECT
      id,
      project_id,
      source_follow_id,
      remote_object_uri,
      remote_activity_uri,
      remote_actor_uri,
      object_type,
      title,
      summary_html_sanitized,
      original_url,
      published_at,
      remote_updated_at,
      received_at
    FROM public.federated_reports
    WHERE project_id = ${input.projectId}::uuid
    ORDER BY COALESCE(published_at, received_at) DESC, id DESC
    LIMIT ${LIST_BY_PROJECT_LIMIT}
  `,
  );
  return rows.map((row) => parseFederatedReportRow(row));
}

/** Parses the first federated report row or returns undefined when empty. */
export function parseOptionalFederatedReportRow(
  rows: readonly unknown[],
): FederatedReport | undefined {
  return parseOptionalRow(rows, parseFederatedReportRow);
}

/** Parses the first federated report row or throws when empty. */
export function parseRequiredFederatedReportRow(rows: readonly unknown[]): FederatedReport {
  const parsed = parseOptionalFederatedReportRow(rows);
  if (!parsed) {
    throw new Error('Expected federated report row was not found.');
  }
  return parsed;
}
