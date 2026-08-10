import type { ReportActivityPayload } from './report-publication-outbox.ts';
import { REPORT_ACTIVITY_PAYLOAD_SCHEMA_VERSION } from './report-publication-outbox.ts';
import type { ObjectRepresentation } from './schema.ts';

/** Parsed recipient inbox target for a materialized outbound activity delivery. */
export type ReportDeliveryRecipient = {
  readonly remoteActorUri: string;
  readonly inboxUri: string;
  readonly sharedInbox: boolean;
  readonly activityType: 'Create' | 'Announce';
  readonly activityUri: string;
  readonly orderingKey: string;
};

/** Input for reconstructing report publication audience at a point in time. */
export type ReconstructReportAudienceInput = {
  readonly publicationOccurredAt: Date;
  readonly projectActorId: string;
  readonly aggregateActorId: string;
  readonly projectFollowers: readonly FollowAudienceRow[];
  readonly aggregateFollowers: readonly FollowAudienceRow[];
};

export type FollowAudienceRow = {
  readonly remoteActorUri: string;
  readonly remoteInboxUri: string;
  readonly remoteSharedInboxUri: string | null;
  readonly acceptedAt: Date;
  readonly undoneAt: Date | null;
};

/** Returns whether a follow was accepted at the given publication instant. */
export function wasFollowAcceptedAt(input: {
  readonly acceptedAt: Date;
  readonly undoneAt: Date | null;
  readonly occurredAt: Date;
}): boolean {
  if (input.acceptedAt.getTime() > input.occurredAt.getTime()) {
    return false;
  }
  if (input.undoneAt && input.undoneAt.getTime() <= input.occurredAt.getTime()) {
    return false;
  }
  return true;
}

/**
 * Reconstructs Create and Announce delivery recipients at publication time.
 * Create wins when the same remote Actor followed both project and aggregate Actors.
 */
export function reconstructReportDeliveryRecipients(
  input: ReconstructReportAudienceInput & {
    readonly createActivityUri: string;
    readonly announceActivityUri: string;
    readonly objectUri: string;
  },
): readonly ReportDeliveryRecipient[] {
  const projectRemoteActors = new Set<string>();
  const recipients: ReportDeliveryRecipient[] = [];

  for (const follow of input.projectFollowers) {
    if (
      !wasFollowAcceptedAt({
        acceptedAt: follow.acceptedAt,
        undoneAt: follow.undoneAt,
        occurredAt: input.publicationOccurredAt,
      })
    ) {
      continue;
    }
    projectRemoteActors.add(follow.remoteActorUri);
    recipients.push(
      buildRecipient({
        follow,
        activityType: 'Create',
        activityUri: input.createActivityUri,
        orderingKey: input.objectUri,
      }),
    );
  }

  for (const follow of input.aggregateFollowers) {
    if (
      !wasFollowAcceptedAt({
        acceptedAt: follow.acceptedAt,
        undoneAt: follow.undoneAt,
        occurredAt: input.publicationOccurredAt,
      })
    ) {
      continue;
    }
    if (projectRemoteActors.has(follow.remoteActorUri)) {
      continue;
    }
    recipients.push(
      buildRecipient({
        follow,
        activityType: 'Announce',
        activityUri: input.announceActivityUri,
        orderingKey: input.objectUri,
      }),
    );
  }

  return dedupeRecipients(recipients);
}

function buildRecipient(input: {
  follow: FollowAudienceRow;
  activityType: 'Create' | 'Announce';
  activityUri: string;
  orderingKey: string;
}): ReportDeliveryRecipient {
  const sharedInbox = input.follow.remoteSharedInboxUri !== null;
  const inboxUri = sharedInbox
    ? (input.follow.remoteSharedInboxUri as string)
    : input.follow.remoteInboxUri;
  return {
    remoteActorUri: input.follow.remoteActorUri,
    inboxUri,
    sharedInbox,
    activityType: input.activityType,
    activityUri: input.activityUri,
    orderingKey: input.orderingKey,
  };
}

/** Dedupes by activity URI and inbox while preserving distinct activity types on shared inboxes. */
export function dedupeRecipients(
  recipients: readonly ReportDeliveryRecipient[],
): readonly ReportDeliveryRecipient[] {
  const seen = new Set<string>();
  const result: ReportDeliveryRecipient[] = [];
  for (const recipient of recipients) {
    const key = `${recipient.activityUri}|${recipient.inboxUri}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(recipient);
  }
  return result;
}

/** Parses bounded report activity payload metadata from a stored activity row. */
export function parseReportActivityPayload(value: unknown): ReportActivityPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid report activity payload.');
  }
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== REPORT_ACTIVITY_PAYLOAD_SCHEMA_VERSION) {
    throw new Error('Unsupported report activity payload schema version.');
  }
  const reportId = payload.reportId;
  const objectRepresentation = payload.objectRepresentation;
  const projectSlug = payload.projectSlug;
  if (typeof reportId !== 'string' || reportId.length === 0) {
    throw new Error('Invalid report activity payload reportId.');
  }
  if (objectRepresentation !== 'article' && objectRepresentation !== 'note') {
    throw new Error('Invalid report activity payload objectRepresentation.');
  }
  if (typeof projectSlug !== 'string' || projectSlug.length === 0) {
    throw new Error('Invalid report activity payload projectSlug.');
  }
  return {
    schemaVersion: REPORT_ACTIVITY_PAYLOAD_SCHEMA_VERSION,
    reportId,
    objectRepresentation,
    projectSlug,
  };
}

/** Escapes plain text for safe Note content embedding. */
export function escapeNoteContentText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Builds Note HTML content with title, summary, and public report URL. */
export function buildNoteContent(input: {
  readonly title: string;
  readonly summary: string;
  readonly publicReportUrl: string;
}): string {
  const title = escapeNoteContentText(input.title);
  const summary = escapeNoteContentText(input.summary);
  const url = escapeNoteContentText(input.publicReportUrl);
  return `<p><strong>${title}</strong></p><p>${summary}</p><p><a href="${url}">${url}</a></p>`;
}

export type MaterializedReportObject = {
  readonly objectRepresentation: ObjectRepresentation;
  readonly objectId: string;
  readonly title: string;
  readonly summary: string;
  readonly publicReportUrl: string;
  readonly publishedAt: Date;
  readonly projectActorUrl: string;
  readonly projectFollowersUrl: string;
  readonly aggregateFollowersUrl: string;
};
