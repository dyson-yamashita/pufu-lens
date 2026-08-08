import { notFound } from 'next/navigation';
import { ActivityPubSubscriptionPanel } from '../../../../src/activitypub-subscription-panel';
import { createDefaultActivityPubSubscriptionSettingsView } from '../../../../src/activitypub-subscription-presentation';
import { isFixtureFallbackEnabled } from '../../../../src/runtime-guards.ts';
import {
  delayActivityPubSubscriptionFollowForE2e,
  delayActivityPubSubscriptionUnfollowForE2e,
  failActivityPubSubscriptionFollowForE2e,
  failActivityPubSubscriptionUnfollowForE2e,
} from './actions.ts';

/**
 * Renders the ActivityPub subscription panel for Playwright E2E coverage.
 */
export default function ActivityPubSubscriptionsE2eHarnessPage() {
  if (!isFixtureFallbackEnabled() || process.env.PUFU_LENS_ENABLE_FIXTURE_FALLBACK !== 'true') {
    notFound();
  }

  const settings = createDefaultActivityPubSubscriptionSettingsView();

  return (
    <main data-testid="activitypub-subscription-e2e-harness">
      <ActivityPubSubscriptionPanel
        canManage
        projectSlug="sample-a"
        settings={settings}
        followAction={delayActivityPubSubscriptionFollowForE2e}
        unfollowAction={delayActivityPubSubscriptionUnfollowForE2e}
      />
      <ActivityPubSubscriptionPanel canManage={false} projectSlug="sample-a" settings={settings} />
      <ActivityPubSubscriptionPanel
        canManage
        projectSlug="sample-a"
        settings={settings}
        followAction={failActivityPubSubscriptionFollowForE2e}
        unfollowAction={failActivityPubSubscriptionUnfollowForE2e}
      />
    </main>
  );
}
