import { registerApiRoute } from '@mastra/core/server';
import { GoogleAuth } from 'google-auth-library';
import {
  ActivityPubDispatcherAuthError,
  activityPubDispatcherAuthConfig,
  verifyActivityPubDispatcherSchedulerToken,
} from './activitypub-dispatcher-auth.ts';
import {
  dispatcherJobRunUrl,
  getCloudAccessTokenWithTimeout,
  safeDispatcherRouteError,
} from './report-schedule-dispatcher-route.ts';

const ACCESS_TOKEN_TIMEOUT_MS = 10_000;
const JOB_LIST_FETCH_TIMEOUT_MS = 15_000;
const JOB_START_FETCH_TIMEOUT_MS = 30_000;
const ACTIVE_EXECUTION_PAGE_SIZE = 20;

type DispatcherJobConfig = {
  readonly jobName: string;
  readonly projectId: string;
  readonly region: string;
};

export class ActivityPubDispatcherRequestError extends Error {}

export type ActivityPubDispatcherRouteDeps = {
  readonly env: NodeJS.ProcessEnv;
  readonly fetcher: typeof fetch;
  readonly getAccessToken: (auth: GoogleAuth, timeoutMs: number) => Promise<string>;
  readonly createAuth: () => GoogleAuth;
  readonly verifyToken: typeof verifyActivityPubDispatcherSchedulerToken;
};

/** Parses ActivityPub dispatcher scheduler JSON request bodies. */
export function parseActivityPubDispatcherJsonBody(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ActivityPubDispatcherRequestError('request body must be valid JSON');
  }
}

/** Parses ActivityPub dispatcher scheduler request bodies; only an empty JSON object is accepted. */
export function parseActivityPubDispatcherRequest(value: unknown): Record<string, never> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  ) {
    throw new ActivityPubDispatcherRequestError('request body must be an empty JSON object');
  }
  return {};
}

/** Handles ActivityPub dispatcher scheduler HTTP requests including JSON body parsing. */
export async function handleActivityPubDispatcherHttpRequest(
  rawBodyText: string,
  authorizationHeader: string | null,
  deps: ActivityPubDispatcherRouteDeps,
): Promise<
  | { readonly status: 202; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401 | 403 | 503; readonly body: { readonly error: string } }
> {
  let body: unknown;
  try {
    body = parseActivityPubDispatcherJsonBody(rawBodyText);
  } catch (error) {
    if (error instanceof ActivityPubDispatcherRequestError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
  return handleActivityPubDispatcherRequest(body, authorizationHeader, deps);
}

/** Handles ActivityPub dispatcher scheduler start requests with injectable dependencies for tests. */
export async function handleActivityPubDispatcherRequest(
  body: unknown,
  authorizationHeader: string | null,
  deps: ActivityPubDispatcherRouteDeps,
): Promise<
  | { readonly status: 202; readonly body: Record<string, unknown> }
  | { readonly status: 400 | 401 | 403 | 503; readonly body: { readonly error: string } }
> {
  try {
    parseActivityPubDispatcherRequest(body);
    const authConfig = activityPubDispatcherAuthConfig(deps.env);
    await deps.verifyToken({
      authorizationHeader,
      config: authConfig,
    });
    const config = dispatcherJobConfig(deps.env);
    const auth = deps.createAuth();
    const token = await deps.getAccessToken(auth, ACCESS_TOKEN_TIMEOUT_MS);
    const active = await hasActiveDispatcherExecution(config, token, deps.fetcher);
    if (active) {
      return { status: 202, body: { accepted: true, noOp: true, execution: null } };
    }
    const execution = await startDispatcherJob(config, token, deps.fetcher);
    return { status: 202, body: { accepted: true, execution } };
  } catch (error) {
    if (error instanceof ActivityPubDispatcherAuthError) {
      return { status: error.statusCode, body: { error: error.message } };
    }
    if (error instanceof ActivityPubDispatcherRequestError) {
      return { status: 400, body: { error: error.message } };
    }
    console.error(
      JSON.stringify({
        error: safeDispatcherRouteError(error),
        event: 'activitypub_dispatcher_start_failed',
      }),
    );
    return { status: 503, body: { error: 'dispatcher job could not be started' } };
  }
}

export const activityPubDispatcherRoute = registerApiRoute(
  '/internal/schedules/activitypub-dispatcher:run',
  {
    method: 'POST',
    // Mastra auth is disabled so the route can verify the designated Scheduler OIDC token itself.
    requiresAuth: false,
    handler: async (context) => {
      const result = await handleActivityPubDispatcherHttpRequest(
        await context.req.raw.text(),
        context.req.header('authorization') ?? null,
        {
          env: process.env,
          fetcher: fetch,
          getAccessToken: getCloudAccessTokenWithTimeout,
          createAuth: () =>
            new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }),
          verifyToken: verifyActivityPubDispatcherSchedulerToken,
        },
      );
      return context.json(result.body, result.status);
    },
  },
);

/** Returns true when the configured ActivityPub dispatcher job already has an active execution. */
export async function hasActiveDispatcherExecution(
  config: DispatcherJobConfig,
  token: string,
  fetcher: typeof fetch,
  options?: { readonly timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? JOB_LIST_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const listUrl = `https://run.googleapis.com/v2/projects/${encodeURIComponent(
      config.projectId,
    )}/locations/${encodeURIComponent(config.region)}/jobs/${encodeURIComponent(
      config.jobName,
    )}/executions?pageSize=${ACTIVE_EXECUTION_PAGE_SIZE}`;
    const response = await fetcher(listUrl, {
      headers: { authorization: `Bearer ${token}` },
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cloud Run Jobs API returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return false;
    }
    const executions = Reflect.get(body, 'executions');
    if (!Array.isArray(executions)) {
      return false;
    }
    return executions.some((execution) => isActiveExecution(execution));
  } finally {
    clearTimeout(timer);
  }
}

function isActiveExecution(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const completionTime = Reflect.get(value, 'completionTime');
  if (completionTime) {
    return false;
  }
  const runningCount = Reflect.get(value, 'runningCount');
  const pendingCount = Reflect.get(value, 'pendingCount');
  if (
    (typeof runningCount === 'number' && runningCount > 0) ||
    (typeof pendingCount === 'number' && pendingCount > 0)
  ) {
    return true;
  }
  return completionTime === undefined || completionTime === null;
}

async function startDispatcherJob(
  config: DispatcherJobConfig,
  token: string,
  fetcher: typeof fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOB_START_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(dispatcherJobRunUrl(config), {
      body: JSON.stringify({
        overrides: {
          containerOverrides: [
            {
              env: [
                { name: 'WORKFLOW_ID', value: 'activitypub-dispatcher' },
                { name: 'WORKFLOW_INPUT_JSON', value: '{}' },
              ],
            },
          ],
        },
      }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cloud Run Jobs API returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const name = Reflect.get(body, 'name');
    return typeof name === 'string' ? name : null;
  } finally {
    clearTimeout(timer);
  }
}

function dispatcherJobConfig(env: NodeJS.ProcessEnv): DispatcherJobConfig {
  return {
    jobName: requiredEnv(env, 'ACTIVITYPUB_DISPATCHER_JOB_NAME'),
    projectId: requiredEnv(env, 'GOOGLE_CLOUD_PROJECT'),
    region: requiredEnv(env, 'CLOUD_RUN_JOBS_REGION'),
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
