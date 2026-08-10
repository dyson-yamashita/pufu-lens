import type postgres from 'postgres';
import {
  buildStableAnnounceActivityUri,
  buildStableCreateActivityUri,
} from './report-activity-uris.ts';
import { parseActivityPubInstanceConfigRow, parseRequiredRow } from './schema.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

/** Schema version for bounded outbound report activity payload metadata. */
export const REPORT_ACTIVITY_PAYLOAD_SCHEMA_VERSION = 1;

/** Bounded safe metadata stored in activitypub_activities.payload_json for report delivery. */
export type ReportActivityPayload = {
  readonly schemaVersion: typeof REPORT_ACTIVITY_PAYLOAD_SCHEMA_VERSION;
  readonly reportId: string;
  readonly objectRepresentation: 'article' | 'note';
  readonly projectSlug: string;
};

/** Raised when report publication outbox enqueue fails after validation. */
export class ReportPublicationOutboxError extends Error {}

/** Raised when a public enabled project requires an enabled aggregate Actor. */
export class ReportPublicationAggregateActorError extends ReportPublicationOutboxError {}

type LockedReportRow = {
  readonly id: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly visibility: 'public' | 'private';
  readonly isPublic: boolean;
  readonly activitypubPublishedAt: Date | null;
};

type LockedActorRow = {
  readonly id: string;
  readonly preferredUsername: string;
  readonly enabled: boolean;
  readonly kind: 'project' | 'aggregate';
};

/**
 * Atomically marks a report public and enqueues deterministic Create / Announce outbound
 * activities when the project is public and its project Actor is enabled.
 *
 * Private projects and disabled project Actors update report state only. Config and aggregate
 * Actor rows are locked only after public project + enabled project Actor are confirmed.
 */
export async function enqueueReportPublicationOutbox(input: {
  readonly sql: postgres.TransactionSql;
  readonly canonicalOrigin: string;
  readonly projectId: string;
  readonly reportId: string;
  readonly publishedAt: Date;
  readonly publicSummary: string;
}): Promise<void> {
  const report = await lockReportForPublication({
    sql: input.sql,
    projectId: input.projectId,
    reportId: input.reportId,
  });
  if (report.isPublic && report.activitypubPublishedAt !== null) {
    return;
  }

  const projectActor = await findProjectActor(input.sql, input.projectId);

  await input.sql`
    UPDATE public.reports
    SET is_public = true,
        activitypub_published_at = ${input.publishedAt},
        activitypub_public_summary = ${input.publicSummary}
    WHERE project_id = ${input.projectId}::uuid
      AND id = ${input.reportId}::uuid
  `;

  if (report.visibility !== 'public' || !projectActor?.enabled) {
    return;
  }

  const config = await lockInstanceConfig(input.sql);
  const aggregateActor = await findAggregateActor(input.sql);

  if (!aggregateActor?.enabled) {
    throw new ReportPublicationAggregateActorError(
      'aggregate Actor is required for enabled project report publication',
    );
  }

  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  const objectUri = uri.reportArticleUrl(input.reportId);
  const payload: ReportActivityPayload = {
    schemaVersion: REPORT_ACTIVITY_PAYLOAD_SCHEMA_VERSION,
    reportId: input.reportId,
    objectRepresentation: config.objectRepresentation,
    projectSlug: report.projectSlug,
  };

  const createActivityUri = buildStableCreateActivityUri({
    canonicalOrigin: input.canonicalOrigin,
    reportId: input.reportId,
  });
  const announceActivityUri = buildStableAnnounceActivityUri({
    canonicalOrigin: input.canonicalOrigin,
    reportId: input.reportId,
  });

  const createInserted = await insertOutboundActivity({
    sql: input.sql,
    activityUri: createActivityUri,
    objectUri,
    activityType: 'Create',
    actorUri: uri.actorUrl(projectActor.preferredUsername),
    localActorId: projectActor.id,
    occurredAt: input.publishedAt,
    payload,
  });
  const announceInserted = await insertOutboundActivity({
    sql: input.sql,
    activityUri: announceActivityUri,
    objectUri,
    activityType: 'Announce',
    actorUri: uri.actorUrl(aggregateActor.preferredUsername),
    localActorId: aggregateActor.id,
    occurredAt: input.publishedAt,
    payload,
  });

  if (!createInserted || !announceInserted) {
    const existingCreate = await countOutboundActivities(input.sql, [
      createActivityUri,
      announceActivityUri,
    ]);
    if (existingCreate !== 2) {
      throw new ReportPublicationOutboxError(
        'Create and Announce outbound activities must be inserted atomically',
      );
    }
  }
}

async function lockReportForPublication(input: {
  sql: postgres.TransactionSql;
  projectId: string;
  reportId: string;
}): Promise<LockedReportRow> {
  const rows = (await input.sql`
    SELECT
      r.id::text AS id,
      r.project_id::text AS project_id,
      p.slug AS project_slug,
      COALESCE(p.visibility, 'private') AS visibility,
      r.is_public,
      r.activitypub_published_at
    FROM public.reports r
    JOIN public.projects p
      ON p.id = r.project_id
    WHERE r.project_id = ${input.projectId}::uuid
      AND r.id = ${input.reportId}::uuid
    FOR UPDATE OF r
  `) as readonly unknown[];
  return parseRequiredRow(rows, parseLockedReportRow);
}

function parseLockedReportRow(value: unknown): LockedReportRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid locked report row.');
  }
  const row = value as Record<string, unknown>;
  const id = row.id;
  const projectId = row.project_id;
  const projectSlug = row.project_slug;
  const visibility = row.visibility;
  const isPublic = row.is_public;
  const activitypubPublishedAt = row.activitypub_published_at;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid locked report row id.');
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('Invalid locked report row project_id.');
  }
  if (typeof projectSlug !== 'string' || projectSlug.length === 0) {
    throw new Error('Invalid locked report row project_slug.');
  }
  if (visibility !== 'public' && visibility !== 'private') {
    throw new Error('Invalid locked report row visibility.');
  }
  if (typeof isPublic !== 'boolean') {
    throw new Error('Invalid locked report row is_public.');
  }
  let parsedActivitypubPublishedAt: Date | null = null;
  if (activitypubPublishedAt !== null && activitypubPublishedAt !== undefined) {
    if (!(activitypubPublishedAt instanceof Date) && typeof activitypubPublishedAt !== 'string') {
      throw new Error('Invalid locked report row activitypub_published_at.');
    }
    const parsed =
      activitypubPublishedAt instanceof Date
        ? activitypubPublishedAt
        : new Date(activitypubPublishedAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid locked report row activitypub_published_at.');
    }
    parsedActivitypubPublishedAt = parsed;
  }
  return {
    id,
    projectId,
    projectSlug,
    visibility,
    isPublic,
    activitypubPublishedAt: parsedActivitypubPublishedAt,
  };
}

async function lockInstanceConfig(
  sql: postgres.TransactionSql,
): Promise<{ objectRepresentation: 'article' | 'note' }> {
  const rows = (await sql`
    SELECT id, object_representation, representation_locked_at, created_at, updated_at
    FROM public.activitypub_instance_config
    WHERE id = 1
    FOR UPDATE
  `) as readonly unknown[];
  const config = parseRequiredRow(rows, parseActivityPubInstanceConfigRow);
  return { objectRepresentation: config.objectRepresentation };
}

async function findProjectActor(
  sql: postgres.TransactionSql,
  projectId: string,
): Promise<LockedActorRow | undefined> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      preferred_username,
      enabled,
      kind
    FROM public.activitypub_actors
    WHERE project_id = ${projectId}::uuid
      AND kind = 'project'
    LIMIT 1
    FOR UPDATE
  `) as readonly unknown[];
  return rows[0] ? parseLockedActorRow(rows[0]) : undefined;
}

async function findAggregateActor(
  sql: postgres.TransactionSql,
): Promise<LockedActorRow | undefined> {
  const rows = (await sql`
    SELECT
      id::text AS id,
      preferred_username,
      enabled,
      kind
    FROM public.activitypub_actors
    WHERE kind = 'aggregate'
    LIMIT 1
    FOR UPDATE
  `) as readonly unknown[];
  return rows[0] ? parseLockedActorRow(rows[0]) : undefined;
}

function parseLockedActorRow(value: unknown): LockedActorRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid locked actor row.');
  }
  const row = value as Record<string, unknown>;
  const id = row.id;
  const preferredUsername = row.preferred_username;
  const enabled = row.enabled;
  const kind = row.kind;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid locked actor row id.');
  }
  if (typeof preferredUsername !== 'string' || preferredUsername.length === 0) {
    throw new Error('Invalid locked actor row preferred_username.');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Invalid locked actor row enabled.');
  }
  if (kind !== 'project' && kind !== 'aggregate') {
    throw new Error('Invalid locked actor row kind.');
  }
  return { id, preferredUsername, enabled, kind };
}

async function insertOutboundActivity(input: {
  sql: postgres.TransactionSql;
  activityUri: string;
  objectUri: string;
  activityType: string;
  actorUri: string;
  localActorId: string;
  occurredAt: Date;
  payload: ReportActivityPayload;
}): Promise<boolean> {
  const rows = (await input.sql`
    INSERT INTO public.activitypub_activities (
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
      ${input.activityUri},
      ${input.objectUri},
      ${input.activityType},
      ${input.actorUri},
      ${input.localActorId}::uuid,
      'outbound',
      ${input.sql.json(
        // postgres helper accepts only a mutable JSON value at the SQL boundary.
        input.payload as never,
      )},
      'pending',
      now(),
      ${input.occurredAt}
    )
    ON CONFLICT (activity_uri) DO NOTHING
    RETURNING id
  `) as readonly unknown[];
  return rows.length > 0;
}

async function countOutboundActivities(
  sql: postgres.TransactionSql,
  activityUris: readonly string[],
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.activitypub_activities
    WHERE activity_uri = ANY(${activityUris})
      AND direction = 'outbound'
  `) as readonly unknown[];
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return 0;
  }
  const count = Reflect.get(row, 'count');
  return typeof count === 'number' ? count : Number(count);
}
