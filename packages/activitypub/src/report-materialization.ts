import { buildNoteContent, escapeNoteContentText } from './report-delivery.ts';
import type { ObjectRepresentation } from './schema.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

const ACTIVITYSTREAMS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const ACTIVITYSTREAMS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

export type MaterializationContext = {
  readonly canonicalOrigin: string;
  readonly reportId: string;
  readonly projectSlug: string;
  readonly title: string;
  readonly publicSummary: string;
  readonly publishedAt: Date;
  readonly objectRepresentation: ObjectRepresentation;
  readonly projectPreferredUsername: string;
  readonly aggregatePreferredUsername: string;
};

/** Builds the embedded Article or Note object for a public report activity. */
export function buildReportObjectJsonLd(input: MaterializationContext): Record<string, unknown> {
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  const objectId = uri.reportArticleUrl(input.reportId);
  const publicReportUrl = uri.publicReportUrl(input.projectSlug, input.reportId);
  const projectActorUrl = uri.actorUrl(input.projectPreferredUsername);
  const audience = {
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [uri.actorFollowersUrl(input.projectPreferredUsername)],
  };
  const base = {
    id: objectId,
    attributedTo: projectActorUrl,
    name: input.title,
    url: publicReportUrl,
    published: input.publishedAt.toISOString(),
    ...audience,
  };
  if (input.objectRepresentation === 'note') {
    return {
      type: 'Note',
      ...base,
      content: buildNoteContent({
        title: input.title,
        summary: input.publicSummary,
        publicReportUrl,
      }),
    };
  }
  return {
    type: 'Article',
    ...base,
    summary: input.publicSummary,
    content: escapeNoteContentText(input.publicSummary),
  };
}

/** Builds a Create activity JSON-LD for a project Actor publication. */
export function buildCreateActivityJsonLd(
  input: MaterializationContext & { readonly activityUri: string },
): Record<string, unknown> {
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: input.activityUri,
    type: 'Create',
    actor: uri.actorUrl(input.projectPreferredUsername),
    object: buildReportObjectJsonLd(input),
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [uri.actorFollowersUrl(input.projectPreferredUsername)],
    published: input.publishedAt.toISOString(),
  };
}

/** Builds an Announce activity JSON-LD for the aggregate Actor publication. */
export function buildAnnounceActivityJsonLd(input: {
  readonly canonicalOrigin: string;
  readonly activityUri: string;
  readonly objectUri: string;
  readonly publishedAt: Date;
  readonly aggregatePreferredUsername: string;
}): Record<string, unknown> {
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  return {
    '@context': ACTIVITYSTREAMS_CONTEXT,
    id: input.activityUri,
    type: 'Announce',
    actor: uri.actorUrl(input.aggregatePreferredUsername),
    object: input.objectUri,
    to: [ACTIVITYSTREAMS_PUBLIC],
    cc: [uri.actorFollowersUrl(input.aggregatePreferredUsername)],
    published: input.publishedAt.toISOString(),
  };
}
