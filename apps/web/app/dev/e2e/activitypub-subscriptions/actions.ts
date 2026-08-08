'use server';

import { assertActivityPubSubscriptionE2eHarnessAllowed } from '../../../../src/activitypub-subscription-e2e-guard.ts';

const E2E_ACTIVITYPUB_SUBSCRIPTION_DELAY_MS = 1_500;

/**
 * Delays ActivityPub subscription form submission so Playwright can observe pending UI state.
 */
export async function delayActivityPubSubscriptionFollowForE2e(_formData: FormData): Promise<void> {
  assertActivityPubSubscriptionE2eHarnessAllowed();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, E2E_ACTIVITYPUB_SUBSCRIPTION_DELAY_MS);
  });
}

/**
 * Simulates resolver failure for ActivityPub subscription E2E error rendering.
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
