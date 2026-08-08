import type { ActivityPubFollowStatus } from '@pufu-lens/activitypub/schema';

/** Outbound subscription row shown in project settings. */
export type ProjectActivityPubSubscriptionView = {
  readonly remoteActorAddress: string;
  readonly status: ActivityPubFollowStatus;
};

/** Project ActivityPub subscription settings read model for settings UI. */
export type ProjectActivityPubSubscriptionSettingsView = {
  readonly federationEnabled: boolean;
  readonly preferredUsername: string | null;
  readonly subscriptions: readonly ProjectActivityPubSubscriptionView[];
};

/** Human-readable labels for follow subscription statuses. */
export function activityPubSubscriptionStatusLabel(status: ActivityPubFollowStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'accepted':
      return 'Accepted';
    case 'undone':
      return 'Undone';
    case 'rejected':
      return 'Rejected';
    default:
      return status;
  }
}

/** Deterministic fixture view for Playwright subscription panel coverage. */
export function createDefaultActivityPubSubscriptionSettingsView(): ProjectActivityPubSubscriptionSettingsView {
  return {
    federationEnabled: true,
    preferredUsername: 'sample-a',
    subscriptions: [
      {
        remoteActorAddress: 'https://remote.fixture.example/users/alice',
        status: 'accepted',
      },
      {
        remoteActorAddress: 'https://remote.fixture.example/users/bob',
        status: 'pending',
      },
    ],
  };
}
