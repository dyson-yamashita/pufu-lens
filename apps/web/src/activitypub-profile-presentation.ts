/** ActivityPub actor profile fields shown in admin settings UI. */
export type ActivityPubActorProfileView = {
  readonly actorId: string | null;
  readonly preferredUsername: string;
  readonly displayName: string;
  readonly iconUrl: string | null;
  readonly additionalPrompt: string | null;
  readonly federationEnabled: boolean;
  readonly canEditProfile: boolean;
  readonly canEditPrompt: boolean;
  readonly profileSavePendingHint: string | null;
};

/** Server-wide aggregate `@all` profile settings view. */
export type ServerActivityPubProfileSettingsView = ActivityPubActorProfileView & {
  readonly deploymentMasterSwitchNote: string;
};

/** Project-scoped ActivityPub profile settings view. */
export type ProjectActivityPubProfileSettingsView = ActivityPubActorProfileView;

/** Deterministic fixture for Playwright app settings coverage. */
export function createDefaultServerActivityPubProfileSettingsView(): ServerActivityPubProfileSettingsView {
  return {
    actorId: '00000000-0000-0000-0000-000000000099',
    preferredUsername: 'all',
    displayName: 'All Projects',
    iconUrl: '/pufu-lens-logo.png',
    additionalPrompt: 'Use a concise editorial tone.',
    federationEnabled: true,
    canEditProfile: true,
    canEditPrompt: true,
    profileSavePendingHint: null,
    deploymentMasterSwitchNote:
      'ACTIVITYPUB_ENABLED remains the deployment master switch. This control changes the aggregate actor only.',
  };
}

/** Deterministic fixture for project admin profile panel coverage. */
export function createDefaultProjectActivityPubProfileSettingsView(): ProjectActivityPubProfileSettingsView {
  return {
    actorId: '00000000-0000-0000-0000-000000000098',
    preferredUsername: 'sample-a',
    displayName: 'Sample Project',
    iconUrl: '/pufu-lens-logo.png',
    additionalPrompt: 'Prefer bullet summaries.',
    federationEnabled: true,
    canEditProfile: true,
    canEditPrompt: true,
    profileSavePendingHint: null,
  };
}
