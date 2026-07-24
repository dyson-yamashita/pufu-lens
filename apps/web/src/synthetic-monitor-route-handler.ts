import type { OAuth2Client } from 'google-auth-library';
import postgres from 'postgres';
import { createReportStorageFromEnv } from './report.ts';
import {
  loadSyntheticMonitorAuthConfig,
  verifySyntheticMonitorBearerToken,
} from './synthetic-monitor-auth.ts';
import {
  parseSyntheticMonitorRequest,
  SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS,
  SyntheticMonitorRequestError,
  safeSyntheticMonitorRouteError,
} from './synthetic-monitor-contract.ts';
import { createPostgresSyntheticMonitorRepository } from './synthetic-monitor-repository.ts';
import {
  parseSyntheticMonitorJsonBody,
  readBoundedRequestBody,
  readSyntheticMonitorBearerToken,
} from './synthetic-monitor-route-body.ts';
import {
  loadSyntheticMonitorProjectSlugs,
  runSyntheticMonitorObservations,
} from './synthetic-monitor-service.ts';

export interface SyntheticMonitorRouteResult {
  readonly body:
    | { readonly error: string }
    | Awaited<ReturnType<typeof runSyntheticMonitorObservations>>;
  readonly status: number;
}

/**
 * Handles a Synthetic Monitor observations POST request with auth-first validation.
 *
 * @param input - Raw request, environment, and optional test dependencies.
 * @returns HTTP status and JSON body.
 */
export async function handleSyntheticMonitorObservationsRequest(input: {
  readonly authorizationHeader: string | null;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly contentLengthHeader: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly authClient?: OAuth2Client;
  readonly createSql?: (databaseUrl: string) => postgres.Sql;
  readonly createStorage?: typeof createReportStorageFromEnv;
}): Promise<SyntheticMonitorRouteResult> {
  try {
    const auth = loadSyntheticMonitorAuthConfig(input.env);
    const bearerToken = readSyntheticMonitorBearerToken(input.authorizationHeader);
    await verifySyntheticMonitorBearerToken({
      auth,
      bearerToken,
      ...(input.authClient ? { client: input.authClient } : {}),
    });
    const boundedBody = await readBoundedRequestBody({
      body: input.body,
      contentLength: input.contentLengthHeader,
    });
    const parsedBody = parseSyntheticMonitorJsonBody(boundedBody.text);
    const request = parseSyntheticMonitorRequest(parsedBody, boundedBody.bytes);
    const allowedProjectSlugs = loadSyntheticMonitorProjectSlugs(input.env);
    if (!allowedProjectSlugs.includes(request.projectSlug)) {
      throw new Error('monitor project scope denied');
    }
    const databaseUrl = input.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const createSql = input.createSql ?? ((url: string) => postgres(url, { max: 1 }));
    const sql = createSql(databaseUrl);
    const storage = (input.createStorage ?? createReportStorageFromEnv)();
    const repository = createPostgresSyntheticMonitorRepository(sql);
    try {
      const response = await withRequestTimeout(
        runSyntheticMonitorObservations({
          allowedProjectSlugs,
          repository,
          request,
          storage,
        }),
        SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS,
      );
      return { status: 200, body: response };
    } finally {
      await sql.end({ timeout: 5 });
    }
  } catch (error) {
    return toSyntheticMonitorRouteResult(error);
  }
}

/**
 * Maps route failures to safe HTTP responses.
 *
 * @param error - Caught route or service error.
 * @returns HTTP status and safe JSON error body.
 */
export function toSyntheticMonitorRouteResult(error: unknown): SyntheticMonitorRouteResult {
  const message = error instanceof Error ? error.message : '';
  const invalidRequest = error instanceof SyntheticMonitorRequestError;
  const authFailure =
    message === 'monitor authentication is required' || message === 'monitor authentication failed';
  const scopeFailure = message === 'monitor project scope denied';
  if (!invalidRequest && !authFailure && !scopeFailure) {
    console.error(
      JSON.stringify({
        error: safeSyntheticMonitorRouteError(error),
        event: 'synthetic_monitor_observations_failed',
      }),
    );
  }
  const status = authFailure ? 401 : invalidRequest ? 400 : scopeFailure ? 403 : 503;
  return { status, body: { error: safeSyntheticMonitorRouteError(error) } };
}

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('synthetic monitor request timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
