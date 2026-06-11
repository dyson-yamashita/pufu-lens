type RuntimeEnv = Partial<Pick<NodeJS.ProcessEnv, 'NEXT_PHASE' | 'NODE_ENV'>> &
  Record<string, string | undefined>;
type DevelopmentBypassEnvName =
  | 'PUFU_LENS_ALLOW_FIXED_USER_FALLBACK'
  | 'PUFU_LENS_ENABLE_ADMIN_PROJECT_LIST';

export function isProductionRuntime(env: RuntimeEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function isProductionBuildPhase(env: RuntimeEnv = process.env): boolean {
  return env.NEXT_PHASE === 'phase-production-build';
}

export function isDevelopmentBypassEnabled(
  envName: DevelopmentBypassEnvName,
  env: RuntimeEnv = process.env,
): boolean {
  return !isProductionRuntime(env) && env[envName] === 'true';
}

export function isFixtureFallbackEnabled(env: RuntimeEnv = process.env): boolean {
  return !isProductionRuntime(env);
}
