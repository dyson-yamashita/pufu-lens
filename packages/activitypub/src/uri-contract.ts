import { parseCanonicalOrigin } from './canonical-origin.ts';

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
      return `${origin}/activitypub/actors/${preferredUsername}`;
    },
    personalInboxUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${preferredUsername}/inbox`;
    },
    sharedInboxUrl: `${origin}/activitypub/inbox`,
    actorOutboxUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${preferredUsername}/outbox`;
    },
    actorFollowersUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${preferredUsername}/followers`;
    },
    actorFollowingUrl(preferredUsername: string) {
      return `${origin}/activitypub/actors/${preferredUsername}/following`;
    },
    reportArticleUrl(reportId: string) {
      return `${origin}/activitypub/reports/${reportId}`;
    },
    publicReportUrl(projectSlug: string, reportId: string) {
      return `${origin}/reports/public/${projectSlug}/${reportId}`;
    },
    actorKeyId(preferredUsername: string) {
      return `${origin}/activitypub/actors/${preferredUsername}#main-key`;
    },
  } as const;
}
