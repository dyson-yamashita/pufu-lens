import assert from 'node:assert/strict';
import {
  isDevelopmentBypassEnabled,
  isFixtureFallbackEnabled,
  isProductionBuildPhase,
  isProductionRuntime,
} from './runtime-guards.ts';

assert.equal(isProductionRuntime({ NODE_ENV: 'production' }), true);
assert.equal(isProductionRuntime({ NODE_ENV: 'development' }), false);
assert.equal(isProductionBuildPhase({ NEXT_PHASE: 'phase-production-build' }), true);
assert.equal(isProductionBuildPhase({ NEXT_PHASE: 'phase-production-server' }), false);
assert.equal(
  isDevelopmentBypassEnabled('PUFU_LENS_ALLOW_FIXED_USER_FALLBACK', {
    NODE_ENV: 'development',
    PUFU_LENS_ALLOW_FIXED_USER_FALLBACK: 'true',
  }),
  true,
);
assert.equal(
  isDevelopmentBypassEnabled('PUFU_LENS_ALLOW_FIXED_USER_FALLBACK', {
    NODE_ENV: 'production',
    PUFU_LENS_ALLOW_FIXED_USER_FALLBACK: 'true',
  }),
  false,
);
assert.equal(isFixtureFallbackEnabled({ NODE_ENV: 'production' }), false);
assert.equal(isFixtureFallbackEnabled({ NODE_ENV: 'test' }), true);

console.log('web runtime guard tests passed');
