import { type LoginTicket, OAuth2Client } from 'google-auth-library';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export type ActivityPubDispatcherAuthConfig = {
  readonly audience: string;
  readonly schedulerSubject: string;
  readonly schedulerServiceAccountEmail: string;
};

export type VerifiedSchedulerIdentity = {
  readonly subject: string;
  readonly email: string;
};

/** Parses ActivityPub dispatcher OIDC auth configuration from environment variables. */
export function activityPubDispatcherAuthConfig(
  env: NodeJS.ProcessEnv,
): ActivityPubDispatcherAuthConfig {
  return {
    audience: requiredEnv(env, 'ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE'),
    schedulerSubject: requiredEnv(env, 'ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT'),
    schedulerServiceAccountEmail: requiredEnv(env, 'SCHEDULER_SERVICE_ACCOUNT'),
  };
}

/**
 * Verifies a Google OIDC bearer token for the ActivityPub dispatcher scheduler route.
 * Never logs the raw token.
 */
export async function verifyActivityPubDispatcherSchedulerToken(input: {
  readonly authorizationHeader: string | null;
  readonly config: ActivityPubDispatcherAuthConfig;
  readonly client?: OAuth2Client;
}): Promise<VerifiedSchedulerIdentity> {
  const token = extractBearerToken(input.authorizationHeader);
  if (!token) {
    throw new ActivityPubDispatcherAuthError('missing bearer token', 401);
  }
  const client = input.client ?? new OAuth2Client();
  let ticket: LoginTicket;
  try {
    ticket = await client.verifyIdToken({
      idToken: token,
      audience: input.config.audience,
    });
  } catch {
    throw new ActivityPubDispatcherAuthError('invalid bearer token', 401);
  }
  const payload = ticket.getPayload();
  if (!payload) {
    throw new ActivityPubDispatcherAuthError('invalid bearer token', 401);
  }
  if (!tokenAudienceMatches(payload.aud, input.config.audience)) {
    throw new ActivityPubDispatcherAuthError('invalid token audience', 403);
  }
  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    throw new ActivityPubDispatcherAuthError('invalid token issuer', 403);
  }
  if (payload.sub !== input.config.schedulerSubject) {
    throw new ActivityPubDispatcherAuthError('invalid token subject', 403);
  }
  const normalizedEmail = payload.email?.trim().toLowerCase();
  const expectedEmail = input.config.schedulerServiceAccountEmail.trim().toLowerCase();
  if (normalizedEmail !== expectedEmail) {
    throw new ActivityPubDispatcherAuthError('invalid token email', 403);
  }
  if (payload.email_verified !== true) {
    throw new ActivityPubDispatcherAuthError('unverified token email', 403);
  }
  return {
    subject: payload.sub,
    email: normalizedEmail ?? expectedEmail,
  };
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function tokenAudienceMatches(audience: string | string[] | undefined, expected: string): boolean {
  if (!audience) {
    return false;
  }
  if (Array.isArray(audience)) {
    return audience.includes(expected);
  }
  return audience === expected;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export class ActivityPubDispatcherAuthError extends Error {
  readonly statusCode: 401 | 403;

  constructor(message: string, statusCode: 401 | 403) {
    super(message);
    this.name = 'ActivityPubDispatcherAuthError';
    this.statusCode = statusCode;
  }
}
