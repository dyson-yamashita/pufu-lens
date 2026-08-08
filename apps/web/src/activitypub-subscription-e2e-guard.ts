import { isFixtureFallbackEnabled, isProductionRuntime } from './runtime-guards.ts';

const FIXTURE_FALLBACK_ENV = 'PUFU_LENS_ENABLE_FIXTURE_FALLBACK';

/**
 * Returns whether the ActivityPub subscription Playwright E2E harness may run.
 * Requires non-production fixture runtime and an explicit fixture fallback flag.
 */
export function isActivityPubSubscriptionE2eHarnessAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isFixtureFallbackEnabled(env) && env[FIXTURE_FALLBACK_ENV] === 'true';
}

/**
 * Fail-closed guard for ActivityPub subscription E2E server actions and harness pages.
 * Rejects production, unset flag, and non-fixture runtimes before timers or dynamic imports.
 */
export function assertActivityPubSubscriptionE2eHarnessAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (isProductionRuntime(env)) {
    throw new Error('ActivityPub subscription E2E harness is disabled in production');
  }
  if (env[FIXTURE_FALLBACK_ENV] !== 'true') {
    throw new Error('ActivityPub subscription E2E harness requires fixture fallback flag');
  }
  if (!isFixtureFallbackEnabled(env)) {
    throw new Error('ActivityPub subscription E2E harness is disabled in this runtime');
  }
}
