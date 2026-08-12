/** Thrown when Step 1 test-only ActivityPub runtime helpers are invoked outside the allowed test runtime. */
export class ActivityPubTestRuntimeDisabledError extends Error {
  constructor() {
    super('ActivityPub test runtime is not enabled');
    this.name = 'ActivityPubTestRuntimeDisabledError';
  }
}

/**
 * Fail-closed guard for Step 1 DB test-only ActivityPub helpers.
 * Requires `ACTIVITYPUB_RUN_DB_TESTS=1` and rejects `NODE_ENV=production`.
 */
export function assertActivityPubDbTestRuntime(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ActivityPubTestRuntimeDisabledError();
  }
  if (process.env.ACTIVITYPUB_RUN_DB_TESTS !== '1') {
    throw new ActivityPubTestRuntimeDisabledError();
  }
}

/**
 * Fail-closed guard for test-only listener harness helpers used by hermetic unit tests.
 * Rejects production runtime but does not require ACTIVITYPUB_RUN_DB_TESTS.
 */
export function assertActivityPubListenerHarnessRuntime(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new ActivityPubTestRuntimeDisabledError();
  }
}

/** Ensures test-only private-address delivery cannot be enabled outside DB test runtime. */
export function assertTestOnlyPrivateAddressAllowed(testOnlyAllowPrivateAddress?: boolean): void {
  if (testOnlyAllowPrivateAddress) {
    assertActivityPubDbTestRuntime();
  }
}

/** Ensures test-only remote resolver overrides cannot bypass production security policy. */
export function assertTestRemoteActorResolverAllowed(testRemoteActorResolver?: unknown): void {
  if (testRemoteActorResolver) {
    assertActivityPubDbTestRuntime();
  }
}

/** Returns true only when the hermetic ActivityPub E2E runtime is fully enabled. */
export function isActivityPubHermeticE2eRuntimeEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.ACTIVITYPUB_RUN_DB_TESTS === '1' &&
    process.env.ACTIVITYPUB_RUN_HERMETIC_E2E === '1'
  );
}

/**
 * Fail-closed guard for hermetic ActivityPub E2E harness entrypoints.
 * Requires `NODE_ENV=test`, `ACTIVITYPUB_RUN_DB_TESTS=1`, and `ACTIVITYPUB_RUN_HERMETIC_E2E=1`.
 */
export function assertActivityPubHermeticE2eRuntime(): void {
  if (!isActivityPubHermeticE2eRuntimeEnabled()) {
    throw new ActivityPubTestRuntimeDisabledError();
  }
}

/** Ensures test-only remote Article resolver overrides stay inside DB test runtime. */
export function assertTestRemoteArticleResolverAllowed(testRemoteArticleResolver?: unknown): void {
  if (testRemoteArticleResolver) {
    assertActivityPubDbTestRuntime();
  }
}

/** Ensures delivery fetch timeout overrides are positive integers in hermetic E2E runtime only. */
export function assertTestDeliveryFetchTimeoutMsAllowed(testDeliveryFetchTimeoutMs?: number): void {
  if (testDeliveryFetchTimeoutMs === undefined) {
    return;
  }
  assertActivityPubHermeticE2eRuntime();
  if (!Number.isInteger(testDeliveryFetchTimeoutMs) || testDeliveryFetchTimeoutMs <= 0) {
    throw new ActivityPubTestRuntimeDisabledError();
  }
}

/**
 * Returns true when inbox queue processing must use Federation.processQueuedTask instead of the listener harness.
 * This is an implementation switch only; it is not a standalone runtime guard.
 */
export function shouldUseHermeticInboxQueueProcessor(): boolean {
  return process.env.ACTIVITYPUB_RUN_HERMETIC_E2E === '1';
}
