type RuntimeEnv = Pick<NodeJS.ProcessEnv, 'NODE_ENV'> & Record<string, string | undefined>;

export function isProductionRuntime(env: RuntimeEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function isDevelopmentBypassEnabled(
  envName: string,
  env: RuntimeEnv = process.env,
): boolean {
  return !isProductionRuntime(env) && env[envName] === 'true';
}

export function isFixtureFallbackEnabled(env: RuntimeEnv = process.env): boolean {
  return !isProductionRuntime(env);
}
