/** ActivityPub actor kind for typed not-found errors at the repository boundary. */
export type ActivityPubActorKind = 'aggregate' | 'project';

/**
 * Raised when a required aggregate or project ActivityPub actor row is missing.
 * Carries actor kind for admin error mapping without exposing internal identifiers.
 */
export class ActivityPubActorNotFoundError extends Error {
  readonly actorKind: ActivityPubActorKind;

  constructor(actorKind: ActivityPubActorKind) {
    super('ActivityPub actor was not found.');
    this.name = 'ActivityPubActorNotFoundError';
    this.actorKind = actorKind;
  }
}

/**
 * Raised when ActivityPub federation is requested for a non-public project.
 * Carries the locked project id for admin error mapping without exposing secrets.
 */
export class ActivityPubProjectNotPublicError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super('Project must be public to enable ActivityPub federation');
    this.name = 'ActivityPubProjectNotPublicError';
    this.projectId = projectId;
  }
}

/**
 * Raised when a preferred username is already bound to another ActivityPub actor.
 * The owner project id is null for aggregate actors.
 */
export class ActivityPubPreferredUsernameConflictError extends Error {
  readonly preferredUsername: string;
  readonly ownerProjectId: string | null;

  constructor(input: { preferredUsername: string; ownerProjectId: string | null }) {
    super('Preferred username conflict: already assigned to another ActivityPub actor');
    this.name = 'ActivityPubPreferredUsernameConflictError';
    this.preferredUsername = input.preferredUsername;
    this.ownerProjectId = input.ownerProjectId;
  }
}
