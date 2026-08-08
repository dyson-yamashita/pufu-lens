'use client';

import { useState } from 'react';
import {
  activityPubSubscriptionStatusLabel,
  type ProjectActivityPubSubscriptionSettingsView,
} from './activitypub-subscription-presentation.ts';
import {
  followRemoteActor,
  unfollowRemoteActor,
} from './admin-activitypub-subscription-actions.ts';
import { ActionForm, PendingSubmitButton } from './form-buttons';

type SubscriptionAction = (formData: FormData) => Promise<void>;

/**
 * Public ActivityPub subscription panel for project settings.
 * Admins may follow/unfollow remote actors; members see sanitized read-only status.
 */
export function ActivityPubSubscriptionPanel({
  canManage,
  projectSlug,
  settings,
  followAction = followRemoteActor,
  unfollowAction = unfollowRemoteActor,
  errorMessage,
}: {
  readonly canManage: boolean;
  readonly projectSlug: string;
  readonly settings: ProjectActivityPubSubscriptionSettingsView;
  readonly followAction?: SubscriptionAction;
  readonly unfollowAction?: SubscriptionAction;
  readonly errorMessage?: string | null;
}) {
  const [address, setAddress] = useState('');

  return (
    <section className="panel" data-testid="activitypub-subscription-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ActivityPub</p>
          <h2>Remote subscriptions</h2>
        </div>
        <span
          className={`status-badge ${settings.federationEnabled ? 'status-healthy' : 'status-held'}`}
          data-testid="activitypub-subscription-federation-status"
        >
          {settings.federationEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      {errorMessage ? (
        <p className="form-error" data-testid="activitypub-subscription-error">
          {errorMessage}
        </p>
      ) : null}
      <dl className="detail-list stacked">
        <div>
          <dt>Federated username</dt>
          <dd className="mono" data-testid="activitypub-subscription-username">
            {settings.preferredUsername ?? '—'}
          </dd>
        </div>
      </dl>
      {canManage && settings.federationEnabled ? (
        <ActionForm
          action={followAction}
          className="detail-edit-form"
          testId="activitypub-subscription-follow-form"
        >
          <input name="projectSlug" type="hidden" value={projectSlug} />
          <label>
            <span>Remote actor address</span>
            <input
              data-testid="activitypub-subscription-address-input"
              name="remoteActorAddress"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="acct:alice@remote.example or https URL"
              required
              type="text"
              value={address}
            />
          </label>
          <div className="action-row">
            <PendingSubmitButton
              className="primary-button"
              testId="activitypub-subscription-follow-button"
              title="Follow remote actor"
            >
              Follow
            </PendingSubmitButton>
          </div>
        </ActionForm>
      ) : null}
      <div className="subscription-list" data-testid="activitypub-subscription-list">
        {settings.subscriptions.length === 0 ? (
          <p className="muted" data-testid="activitypub-subscription-empty">
            No outbound subscriptions yet.
          </p>
        ) : (
          <ul className="stacked-list">
            {settings.subscriptions.map((subscription) => (
              <li
                className="stacked-list-item"
                data-testid={`activitypub-subscription-item-${encodeURIComponent(subscription.remoteActorAddress)}`}
                key={subscription.remoteActorAddress}
              >
                <div>
                  <p className="mono">{subscription.remoteActorAddress}</p>
                  <p
                    className="muted"
                    data-testid={`activitypub-subscription-status-${encodeURIComponent(subscription.remoteActorAddress)}`}
                  >
                    {activityPubSubscriptionStatusLabel(subscription.status)}
                  </p>
                </div>
                {canManage &&
                settings.federationEnabled &&
                subscription.status !== 'undone' &&
                subscription.status !== 'rejected' ? (
                  <ActionForm
                    action={unfollowAction}
                    testId="activitypub-subscription-unfollow-form"
                  >
                    <input name="projectSlug" type="hidden" value={projectSlug} />
                    <input
                      name="remoteActorUri"
                      type="hidden"
                      value={subscription.remoteActorAddress}
                    />
                    <PendingSubmitButton
                      className="secondary-button"
                      testId={`activitypub-subscription-unfollow-${encodeURIComponent(subscription.remoteActorAddress)}`}
                      title="Unfollow remote actor"
                    >
                      Unfollow
                    </PendingSubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
