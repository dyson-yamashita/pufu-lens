'use server';

import { assertActivityPubSubscriptionE2eHarnessAllowed } from '../../../../src/activitypub-subscription-e2e-guard.ts';

const E2E_ACTIVITYPUB_SUBSCRIPTION_DELAY_MS = 1_500;

/**
 * Delays ActivityPub subscription form submission so Playwright can observe pending UI state.
 * {@link assertActivityPubSubscriptionE2eHarnessAllowed} rejects production, unset fixture
 * fallback flag, and non-fixture runtimes by throwing Error before any timer wait.
 * When allowed, waits via `setTimeout` for the configured E2E delay duration.
 */
export async function delayActivityPubSubscriptionFollowForE2e(_formData: FormData): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, E2E_ACTIVITYPUB_SUBSCRIPTION_DELAY_MS);
  });
}

/**
 * Simulates resolver failure for ActivityPub subscription E2E error rendering.
 * {@link assertActivityPubSubscriptionE2eHarnessAllowed} rejects production, unset fixture
 * fallback flag, and non-fixture runtimes by throwing Error before dynamic import.
 * When allowed, throws `ActivityPubSubscriptionError` for remote resolution failure.
 */
export async function failActivityPubSubscriptionFollowForE2e(_formData: FormData): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  const { ActivityPubSubscriptionError } = await import(
    '../../../../src/activitypub-subscription-errors.ts'
  );
  throw new ActivityPubSubscriptionError(
    'remote_resolution_failed',
    'The remote actor address could not be resolved.',
  );
}

/**
 * Delays unfollow submission so Playwright can observe pending UI state.
 * {@link assertActivityPubSubscriptionE2eHarnessAllowed} rejects production, unset fixture
 * fallback flag, and non-fixture runtimes by throwing Error before any timer wait.
 * When allowed, waits via `setTimeout` for the configured E2E delay duration.
 */
export async function delayActivityPubSubscriptionUnfollowForE2e(
  _formData: FormData,
): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, E2E_ACTIVITYPUB_SUBSCRIPTION_DELAY_MS);
  });
}

/**
 * Simulates resolver failure for ActivityPub subscription unfollow E2E error rendering.
 * {@link assertActivityPubSubscriptionE2eHarnessAllowed} rejects production, unset fixture
 * fallback flag, and non-fixture runtimes by throwing Error before dynamic import.
 * When allowed, throws `ActivityPubSubscriptionError` for remote resolution failure.
 */
export async function failActivityPubSubscriptionUnfollowForE2e(
  _formData: FormData,
): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  const { ActivityPubSubscriptionError } = await import(
    '../../../../src/activitypub-subscription-errors.ts'
  );
  throw new ActivityPubSubscriptionError(
    'remote_resolution_failed',
    'The remote actor address could not be resolved.',
  );
}

/**
 * Delays federation enable/disable submission so Playwright can observe pending UI state.
 * {@link assertActivityPubSubscriptionE2eHarnessAllowed} rejects production, unset fixture
 * fallback flag, and non-fixture runtimes by throwing Error before any timer wait.
 * When allowed, waits via `setTimeout` for the configured E2E delay duration.
 */
export async function delayActivityPubSubscriptionFederationForE2e(
  _formData: FormData,
): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, E2E_ACTIVITYPUB_SUBSCRIPTION_DELAY_MS);
  });
}

/**
 * Simulates federation mutation failure for ActivityPub federation E2E error rendering.
 * {@link assertActivityPubSubscriptionE2eHarnessAllowed} rejects production, unset fixture
 * fallback flag, and non-fixture runtimes by throwing Error before dynamic import.
 * When allowed, throws `ActivityPubAdminError` with a sanitized public-project message.
 */
export async function failActivityPubSubscriptionFederationForE2e(
  _formData: FormData,
): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  const { ActivityPubAdminError } = await import('../../../../src/activitypub-admin.ts');
  throw new ActivityPubAdminError(
    'project_not_public',
    'Project must be public to enable ActivityPub federation',
    400,
  );
}
