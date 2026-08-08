import { validateProjectSlug } from '@pufu-lens/project-tenancy';
import { ActivityPubSubscriptionError } from './activitypub-subscription-errors.ts';

const MAX_REMOTE_INPUT_LENGTH = 512;

/** Validates project slug for ActivityPub subscription mutations. */
export function validateSubscriptionProjectSlugOrThrow(projectSlug: string): void {
  try {
    validateProjectSlug(projectSlug);
  } catch {
    throw new ActivityPubSubscriptionError('invalid_slug', 'Invalid project slug');
  }
}

/** Validates remote actor address input for outbound Follow requests. */
export function validateSubscriptionRemoteActorAddressOrThrow(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REMOTE_INPUT_LENGTH) {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor address is invalid',
    );
  }
  if (trimmed.startsWith('https://')) {
    validateHttpsRemoteActorUrlOrThrow(trimmed);
    return;
  }
  let candidate = trimmed;
  if (candidate.startsWith('acct:')) {
    candidate = candidate.slice('acct:'.length);
  }
  if (candidate.startsWith('@')) {
    candidate = candidate.slice(1);
  }
  const atIndex = candidate.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === candidate.length - 1) {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor address is invalid',
    );
  }
}

/** Validates stored remote actor HTTPS URIs for unfollow mutations. */
export function validateSubscriptionRemoteActorUriOrThrow(value: string): void {
  validateHttpsRemoteActorUrlOrThrow(value.trim());
}

function validateHttpsRemoteActorUrlOrThrow(value: string): void {
  if (value.length === 0 || value.length > MAX_REMOTE_INPUT_LENGTH) {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor address is invalid',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor address is invalid',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor addresses must use HTTPS',
    );
  }
  if (parsed.username || parsed.password) {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor address is invalid',
    );
  }
  if (parsed.hash.length > 0) {
    throw new ActivityPubSubscriptionError(
      'invalid_actor_address',
      'Remote actor address is invalid',
    );
  }
}
