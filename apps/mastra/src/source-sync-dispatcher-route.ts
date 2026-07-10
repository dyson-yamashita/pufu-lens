import { registerApiRoute } from '@mastra/core/server';
import { GoogleAuth } from 'google-auth-library';

type DispatcherJobConfig = {
  readonly jobName: string;
  readonly projectId: string;
  readonly region: string;
};

export const sourceSyncDispatcherRoute = registerApiRoute(
  '/internal/schedules/source-sync-dispatcher:run',
  {
    method: 'POST',
    // Cloud Run IAM (--no-allow-unauthenticated) is the OIDC authentication boundary.
    // Mastra auth is intentionally disabled so the Google-signed bearer token is not
    // interpreted as an application user token.
    requiresAuth: false,
    handler: async (context) => {
      try {
        parseDispatcherRequest(await readJsonBody(context.req.raw));
        const config = dispatcherJobConfig(process.env);
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const token = await auth.getAccessToken();
        if (!token) throw new Error('cloud access token unavailable');
        const execution = await startDispatcherJob(config, token, fetch);
        return context.json({ accepted: true, execution }, 202);
      } catch (error) {
        const invalidRequest = error instanceof DispatcherRequestError;
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

export function dispatcherJobRunUrl(config: DispatcherJobConfig): string {
  return `https://run.googleapis.com/v2/projects/${encodeURIComponent(
    config.projectId,
  )}/locations/${encodeURIComponent(config.region)}/jobs/${encodeURIComponent(config.jobName)}:run`;
}

export async function startDispatcherJob(
  config: DispatcherJobConfig,
  token: string,
  fetcher: typeof fetch,
): Promise<string | null> {
  const response = await fetcher(dispatcherJobRunUrl(config), {
    body: JSON.stringify({
      overrides: {
        containerOverrides: [{ env: [{ name: 'WORKFLOW_INPUT_JSON', value: '{}' }] }],
      },
    }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) throw new Error(`Cloud Run Jobs API returned HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => ({}));
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = Reflect.get(body, 'name');
  return typeof name === 'string' ? name : null;
}

function dispatcherJobConfig(env: NodeJS.ProcessEnv): DispatcherJobConfig {
  return {
    jobName: requiredEnv(env, 'SOURCE_SYNC_DISPATCHER_JOB_NAME'),
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
