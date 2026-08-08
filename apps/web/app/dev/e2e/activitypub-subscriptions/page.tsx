import { notFound } from 'next/navigation';
import { isActivityPubSubscriptionE2eHarnessAllowed } from '../../../../src/activitypub-subscription-e2e-guard.ts';
import { ActivityPubSubscriptionPanel } from '../../../../src/activitypub-subscription-panel';
import { createDefaultActivityPubSubscriptionSettingsView } from '../../../../src/activitypub-subscription-presentation';
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
  if (!isActivityPubSubscriptionE2eHarnessAllowed()) {
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
