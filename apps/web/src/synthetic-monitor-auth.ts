import { OAuth2Client } from 'google-auth-library';
import { parseSyntheticMonitorServiceAccounts } from './synthetic-monitor-contract.ts';

export interface SyntheticMonitorAuthConfig {
  readonly allowedServiceAccounts: readonly string[];
  readonly audience: string;
}

export interface VerifiedSyntheticMonitorPrincipal {
  readonly email: string;
}

/**
 * Loads Synthetic Monitor authentication configuration from environment variables.
 *
 * @param env - Process environment.
 * @returns Audience and service-account allowlist settings.
 */
export function loadSyntheticMonitorAuthConfig(env: NodeJS.ProcessEnv): SyntheticMonitorAuthConfig {
  const audience = requiredEnv(env, 'SYNTHETIC_MONITOR_OIDC_AUDIENCE');
  const allowedServiceAccounts = parseSyntheticMonitorServiceAccounts(
    requiredEnv(env, 'SYNTHETIC_MONITOR_SERVICE_ACCOUNTS'),
  );
  return { allowedServiceAccounts, audience };
}

/**
 * Verifies a Google-signed ID token for the Synthetic Monitor service account boundary.
 *
 * @param input - Bearer token, auth config, and optional OAuth client for tests.
 * @returns Verified principal email when allowlisted.
 */
export async function verifySyntheticMonitorBearerToken(input: {
  readonly auth: SyntheticMonitorAuthConfig;
  readonly bearerToken: string;
  readonly client?: OAuth2Client;
}): Promise<VerifiedSyntheticMonitorPrincipal> {
  const token = input.bearerToken.trim();
  if (!token) {
    throw new Error('monitor authentication is required');
  }
  const client = input.client ?? new OAuth2Client();
  let payload: { email?: string; email_verified?: boolean } | undefined;
  try {
    const ticket = await client.verifyIdToken({
      audience: input.auth.audience,
      idToken: token,
    });
    payload = ticket.getPayload();
  } catch {
    throw new Error('monitor authentication failed');
  }
  const email = payload?.email?.trim().toLowerCase();
  if (!email || payload?.email_verified !== true) {
    throw new Error('monitor authentication failed');
  }
  if (!input.auth.allowedServiceAccounts.includes(email)) {
    throw new Error('monitor authentication failed');
  }
  return { email };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
