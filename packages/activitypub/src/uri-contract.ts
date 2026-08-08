import { parseCanonicalOrigin } from './canonical-origin.ts';

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Builds stable ActivityPub resource URLs for a configured canonical origin. */
export function buildActivityPubUriContract(canonicalOrigin: string) {
  const { origin, host } = parseCanonicalOrigin(canonicalOrigin);
  return {
    canonicalHost: host,
    canonicalOrigin: origin,
    webfingerAcct(preferredUsername: string) {
      return `acct:${preferredUsername}@${host}`;
    },
    actorUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${encodePathSegment(preferredUsername)}`;
    },
    personalInboxUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${encodePathSegment(preferredUsername)}/inbox`;
    },
    sharedInboxUrl: `${origin}/activitypub/inbox`,
    actorOutboxUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${encodePathSegment(preferredUsername)}/outbox`;
    },
    actorFollowersUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${encodePathSegment(preferredUsername)}/followers`;
    },
    actorFollowingUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${encodePathSegment(preferredUsername)}/following`;
    },
    reportArticleUrl(reportId: string) {
      return `${origin}/activitypub/reports/${encodePathSegment(reportId)}`;
    },
    publicReportUrl(projectSlug: string, reportId: string) {
      return `${origin}/reports/public/${encodePathSegment(projectSlug)}/${encodePathSegment(reportId)}`;
    },
    actorKeyId(preferredUsername: string) {
      return `${origin}/activitypub/actors/${encodePathSegment(preferredUsername)}#main-key`;
    },
  } as const;
}
