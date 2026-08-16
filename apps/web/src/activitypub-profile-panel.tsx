'use client';

import { useMemo } from 'react';
import type {
  ProjectActivityPubProfileSettingsView,
  ServerActivityPubProfileSettingsView,
} from './activitypub-profile-presentation.ts';
import {
  saveAggregateActivityPubProfile,
  saveProjectActivityPubProfile,
  setAggregateActivityPubFederationEnabled,
} from './admin-activitypub-profile-actions.ts';
import { ActionForm, PendingSubmitButton } from './form-buttons';

type ProfileAction = (formData: FormData) => Promise<void>;
type FederationAction = (formData: FormData) => Promise<void>;

function resolveIconPreviewUrl(iconUrl: string | null): string | null {
  if (!iconUrl) {
    return null;
  }
  if (iconUrl.startsWith('//')) {
    return null;
  }
  if (iconUrl.startsWith('https://') || iconUrl.startsWith('/')) {
    return iconUrl;
  }
  return null;
}

/**
 * Reusable ActivityPub profile editor for aggregate and project actors.
 */
export function ActivityPubProfilePanel({
  scope,
  settings,
  saveAction,
  federationAction,
  projectSlug,
}: {
  readonly scope: 'aggregate' | 'project';
  readonly settings: ServerActivityPubProfileSettingsView | ProjectActivityPubProfileSettingsView;
  readonly saveAction?: ProfileAction;
  readonly federationAction?: FederationAction;
  readonly projectSlug?: string;
}) {
  const iconPreviewUrl = useMemo(() => resolveIconPreviewUrl(settings.iconUrl), [settings.iconUrl]);
  const profilePending = Boolean(settings.profileSavePendingHint);
  const resolvedSaveAction =
    saveAction ??
    (scope === 'aggregate' ? saveAggregateActivityPubProfile : saveProjectActivityPubProfile);
  const resolvedFederationAction =
    scope === 'aggregate'
      ? (federationAction ?? setAggregateActivityPubFederationEnabled)
      : undefined;
  const testIdPrefix =
    scope === 'aggregate' ? 'activitypub-aggregate-profile' : 'activitypub-project-profile';

  return (
    <section className="panel activitypub-profile-panel" data-testid={`${testIdPrefix}-panel`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ActivityPub</p>
          <h2>{scope === 'aggregate' ? '@all profile' : 'Federation profile'}</h2>
        </div>
        <span
          className={`status-badge ${settings.federationEnabled ? 'status-healthy' : 'status-held'}`}
          data-testid={`${testIdPrefix}-status`}
        >
          {settings.federationEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      {'deploymentMasterSwitchNote' in settings ? (
        <p className="muted" data-testid={`${testIdPrefix}-deployment-note`}>
          {settings.deploymentMasterSwitchNote}
        </p>
      ) : null}
      <dl className="detail-list stacked">
        <div>
          <dt>Federated username</dt>
          <dd className="mono" data-testid={`${testIdPrefix}-username`}>
            {settings.preferredUsername}
          </dd>
        </div>
      </dl>
      {settings.canEditProfile ? (
        <ActionForm
          action={resolvedSaveAction}
          className="detail-edit-form activitypub-profile-form"
          testId={`${testIdPrefix}-form`}
        >
          {scope === 'project' && projectSlug ? (
            <input name="projectSlug" type="hidden" value={projectSlug} />
          ) : null}
          <label>
            <span>Display name</span>
            <input
              data-testid={`${testIdPrefix}-display-name-input`}
              defaultValue={settings.displayName}
              maxLength={100}
              name="displayName"
              required
              type="text"
            />
          </label>
          <label>
            <span>Icon URL</span>
            <input
              data-testid={`${testIdPrefix}-icon-url-input`}
              defaultValue={settings.iconUrl ?? ''}
              inputMode="url"
              maxLength={2048}
              name="iconUrl"
              placeholder="/pufu-lens-logo.png or https://example.com/icon.png"
              type="text"
            />
          </label>
          {iconPreviewUrl ? (
            <div className="activitypub-icon-preview" data-testid={`${testIdPrefix}-icon-preview`}>
              {/* biome-ignore lint/performance/noImgElement: Admin-configured remote icon origins cannot be declared statically for Next Image. */}
              <img alt="" src={iconPreviewUrl} />
            </div>
          ) : null}
          {settings.canEditPrompt ? (
            <label>
              <span>
                {scope === 'aggregate' ? 'Server-wide post prompt' : 'Project post prompt'}
              </span>
              <textarea
                data-testid={`${testIdPrefix}-prompt-textarea`}
                defaultValue={settings.additionalPrompt ?? ''}
                maxLength={2000}
                name="additionalPrompt"
                rows={4}
              />
            </label>
          ) : null}
          {profilePending ? (
            <p className="muted" data-testid={`${testIdPrefix}-save-pending-hint`}>
              {settings.profileSavePendingHint}
            </p>
          ) : null}
          <div className="action-row">
            <PendingSubmitButton
              className="primary-button"
              disabled={profilePending}
              pendingLabel="Saving..."
              testId={`${testIdPrefix}-save-button`}
              title="Save ActivityPub profile"
            >
              Save profile
            </PendingSubmitButton>
          </div>
        </ActionForm>
      ) : (
        <dl className="detail-list stacked">
          <div>
            <dt>Display name</dt>
            <dd data-testid={`${testIdPrefix}-display-name-readonly`}>{settings.displayName}</dd>
          </div>
          {settings.iconUrl ? (
            <div>
              <dt>Icon</dt>
              <dd>
                {iconPreviewUrl ? (
                  <div
                    className="activitypub-icon-preview"
                    data-testid={`${testIdPrefix}-icon-preview`}
                  >
                    {/* biome-ignore lint/performance/noImgElement: Admin-configured remote icon origins cannot be declared statically for Next Image. */}
                    <img alt="" src={iconPreviewUrl} />
                  </div>
                ) : (
                  settings.iconUrl
                )}
              </dd>
            </div>
          ) : null}
        </dl>
      )}
      {scope === 'aggregate' && settings.canEditProfile && resolvedFederationAction ? (
        <ActionForm
          action={resolvedFederationAction}
          className="detail-edit-form"
          testId={`${testIdPrefix}-federation-form`}
        >
          <input
            name="enabled"
            type="hidden"
            value={settings.federationEnabled ? 'false' : 'true'}
          />
          <div className="action-row">
            <PendingSubmitButton
              className={settings.federationEnabled ? 'secondary-link' : 'primary-button'}
              pendingLabel={settings.federationEnabled ? 'Disabling...' : 'Enabling...'}
              testId={`${testIdPrefix}-federation-toggle-button`}
              title={
                settings.federationEnabled
                  ? 'Disable ActivityPub actor'
                  : 'Enable ActivityPub actor'
              }
            >
              {settings.federationEnabled ? 'Disable ActivityPub' : 'Enable ActivityPub'}
            </PendingSubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </section>
  );
}
