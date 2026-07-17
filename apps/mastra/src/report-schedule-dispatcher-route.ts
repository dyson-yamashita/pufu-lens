import { registerApiRoute } from '@mastra/core/server';
import { GoogleAuth } from 'google-auth-library';

const ACCESS_TOKEN_TIMEOUT_MS = 10_000;
const JOB_START_FETCH_TIMEOUT_MS = 30_000;
const DISPATCHER_JOB_FETCH_TIMEOUT_ERROR = 'dispatcher job fetch timed out';

type DispatcherJobConfig = {
  readonly jobName: string;
  readonly projectId: string;
  readonly region: string;
};

export const reportScheduleDispatcherRoute = registerApiRoute(
  '/internal/schedules/report-schedule-dispatcher:run',
  {
    method: 'POST',
    requiresAuth: false,
    handler: async (context) => {
      try {
        parseDispatcherRequest(await readJsonBody(context.req.raw));
        const config = dispatcherJobConfig(process.env);
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const token = await getCloudAccessTokenWithTimeout(auth);
        const execution = await startDispatcherJob(config, token, fetch);
        return context.json({ accepted: true, execution }, 202);
      } catch (error) {
        const invalidRequest = error instanceof DispatcherRequestError;
        if (!invalidRequest) {
          console.error(
            JSON.stringify({
              error: safeDispatcherRouteError(error),
              event: 'report_schedule_dispatcher_start_failed',
            }),
          );
        }
        return context.json(
          { error: invalidRequest ? error.message : 'dispatcher job could not be started' },
          invalidRequest ? 400 : 503,
        );
      }
    },
  },
);

export function parseDispatcherRequest(value: unknown): Record<string, never> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  ) {
    throw new DispatcherRequestError('request body must be an empty JSON object');
  }
  return {};
}

export function safeDispatcherRouteError(error: unknown): string {
  if (error instanceof Error) {
    const httpStatus = error.message.match(/HTTP (\d{3})/i)?.[1];
    if (httpStatus) return `Cloud Run Jobs API HTTP ${httpStatus}`;
    if (/^[A-Z0-9_]+ is required$/.test(error.message)) return error.message;
    if (error.message === 'cloud access token unavailable') return error.message;
  }
  return 'dispatcher job start failed';
}

export function dispatcherJobRunUrl(config: DispatcherJobConfig): string {
  return `https://run.googleapis.com/v2/projects/${encodeURIComponent(
    config.projectId,
  )}/locations/${encodeURIComponent(config.region)}/jobs/${encodeURIComponent(config.jobName)}:run`;
}

export async function getCloudAccessTokenWithTimeout(
  auth: GoogleAuth,
  timeoutMs: number = ACCESS_TOKEN_TIMEOUT_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tokenPromise = auth.getAccessToken();
  void tokenPromise.catch(() => undefined);
  try {
    const token = await Promise.race([
      tokenPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('cloud access token timed out')), timeoutMs);
      }),
    ]);
    if (!token) throw new Error('cloud access token unavailable');
    return token;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function startDispatcherJob(
  config: DispatcherJobConfig,
  token: string,
  fetcher: typeof fetch,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? JOB_START_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let externalAbortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      reject(new Error(DISPATCHER_JOB_FETCH_TIMEOUT_ERROR));
    }, timeoutMs);
  });
  try {
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        externalAbortHandler = () => controller.abort();
        options.signal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }
    const fetchPromise = fetcher(dispatcherJobRunUrl(config), {
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{ env: [{ name: 'WORKFLOW_INPUT_JSON', value: '{}' }] }],
        },
      }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Cloud Run Jobs API returned HTTP ${response.status}`);
      const body: unknown = await response.json().catch(() => ({}));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const name = Reflect.get(body, 'name');
      return typeof name === 'string' ? name : null;
    });
    void fetchPromise.catch(() => undefined);
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (options?.signal && externalAbortHandler) {
      options.signal.removeEventListener('abort', externalAbortHandler);
    }
  }
}

function dispatcherJobConfig(env: NodeJS.ProcessEnv): DispatcherJobConfig {
  return {
    jobName: requiredEnv(env, 'REPORT_SCHEDULE_DISPATCHER_JOB_NAME'),
    projectId: requiredEnv(env, 'GOOGLE_CLOUD_PROJECT'),
    region: requiredEnv(env, 'CLOUD_RUN_JOBS_REGION'),
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DispatcherRequestError('request body must be valid JSON');
  }
}

class DispatcherRequestError extends Error {}
