import { parseCanonicalOrigin } from './canonical-origin.ts';

/** Stable Create activity URI for a published public report. */
export function buildStableCreateActivityUri(input: {
  readonly canonicalOrigin: string;
  readonly reportId: string;
}): string {
  const { origin } = parseCanonicalOrigin(input.canonicalOrigin);
  return `${origin}/activitypub/activities/create/${encodeURIComponent(input.reportId)}`;
}

/** Stable Announce activity URI for a published public report. */
export function buildStableAnnounceActivityUri(input: {
  readonly canonicalOrigin: string;
  readonly reportId: string;
}): string {
  const { origin } = parseCanonicalOrigin(input.canonicalOrigin);
  return `${origin}/activitypub/activities/announce/${encodeURIComponent(input.reportId)}`;
}
