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
  if (process.env.NODE_ENV === 'production') {
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
