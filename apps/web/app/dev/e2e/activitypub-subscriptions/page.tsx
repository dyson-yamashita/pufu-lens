import { notFound } from 'next/navigation';
import { isActivityPubSubscriptionE2eHarnessAllowed } from '../../../../src/activitypub-subscription-e2e-guard.ts';
import { ActivityPubSubscriptionPanel } from '../../../../src/activitypub-subscription-panel';
import { createDefaultActivityPubSubscriptionSettingsView } from '../../../../src/activitypub-subscription-presentation';
import {
  delayActivityPubSubscriptionFederationForE2e,
  delayActivityPubSubscriptionFollowForE2e,
  delayActivityPubSubscriptionUnfollowForE2e,
  failActivityPubSubscriptionFederationForE2e,
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

  const enabledSettings = createDefaultActivityPubSubscriptionSettingsView();
  const disabledSettings = {
    ...enabledSettings,
    federationEnabled: false,
    subscriptions: [],
  };

  return (
    <main data-testid="activitypub-subscription-e2e-harness">
      <div data-testid="activitypub-subscription-e2e-admin-enabled">
        <ActivityPubSubscriptionPanel
          canManage
          projectSlug="sample-a"
          settings={enabledSettings}
          followAction={delayActivityPubSubscriptionFollowForE2e}
          unfollowAction={delayActivityPubSubscriptionUnfollowForE2e}
        />
      </div>
      <div data-testid="activitypub-subscription-e2e-admin-disabled">
        <ActivityPubSubscriptionPanel
          canManage
          federationAction={delayActivityPubSubscriptionFederationForE2e}
          projectSlug="sample-a"
          settings={disabledSettings}
        />
      </div>
      <div data-testid="activitypub-subscription-e2e-member">
        <ActivityPubSubscriptionPanel
          canManage={false}
          projectSlug="sample-a"
          settings={enabledSettings}
        />
      </div>
      <div data-testid="activitypub-subscription-e2e-admin-ineligible">
        <ActivityPubSubscriptionPanel
          canEnableFederation={false}
          canManage
          projectSlug="sample-a"
          settings={disabledSettings}
        />
      </div>
      <div data-testid="activitypub-subscription-e2e-follow-error">
        <ActivityPubSubscriptionPanel
          canManage
          projectSlug="sample-a"
          settings={enabledSettings}
          followAction={failActivityPubSubscriptionFollowForE2e}
          unfollowAction={failActivityPubSubscriptionUnfollowForE2e}
        />
      </div>
      <div data-testid="activitypub-subscription-e2e-federation-error">
        <ActivityPubSubscriptionPanel
          canManage
          federationAction={failActivityPubSubscriptionFederationForE2e}
          projectSlug="sample-a"
          settings={disabledSettings}
        />
      </div>
    </main>
  );
}
