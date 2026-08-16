import { notFound } from 'next/navigation';
import { ActivityPubProfilePanel } from '../../../../src/activitypub-profile-panel';
import {
  createDefaultProjectActivityPubProfileSettingsView,
  createDefaultServerActivityPubProfileSettingsView,
} from '../../../../src/activitypub-profile-presentation';
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
  const enabledProfileSettings = createDefaultProjectActivityPubProfileSettingsView();
  const pendingProfileSettings = {
    ...enabledProfileSettings,
    actorId: null,
    displayName: '',
    iconUrl: null,
    additionalPrompt: null,
    federationEnabled: false,
    profileSavePendingHint: 'Enable ActivityPub for this project before saving profile settings.',
  };
  const disabledEditableProfileSettings = {
    ...enabledProfileSettings,
    federationEnabled: false,
    profileSavePendingHint: null,
  };
  const memberProfileSettings = {
    ...enabledProfileSettings,
    canEditProfile: false,
    canEditPrompt: false,
    additionalPrompt: null,
  };
  const aggregateProfileSettings = createDefaultServerActivityPubProfileSettingsView();
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
          federationAction={delayActivityPubSubscriptionFederationForE2e}
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
      <div data-testid="activitypub-profile-e2e-admin-enabled">
        <ActivityPubProfilePanel
          projectSlug="sample-a"
          scope="project"
          settings={enabledProfileSettings}
        />
      </div>
      <div data-testid="activitypub-profile-e2e-admin-pending">
        <ActivityPubProfilePanel
          projectSlug="sample-a"
          scope="project"
          settings={pendingProfileSettings}
        />
      </div>
      <div data-testid="activitypub-profile-e2e-admin-disabled-editable">
        <ActivityPubProfilePanel
          projectSlug="sample-a"
          scope="project"
          settings={disabledEditableProfileSettings}
        />
      </div>
      <div data-testid="activitypub-profile-e2e-member">
        <ActivityPubProfilePanel
          projectSlug="sample-a"
          scope="project"
          settings={memberProfileSettings}
        />
      </div>
      <div data-testid="activitypub-profile-e2e-aggregate">
        <ActivityPubProfilePanel scope="aggregate" settings={aggregateProfileSettings} />
      </div>
    </main>
  );
}
