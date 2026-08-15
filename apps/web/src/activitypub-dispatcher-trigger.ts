import { GoogleAuth } from 'google-auth-library';

const ACCESS_TOKEN_TIMEOUT_MS = 2_000;
const JOB_RUN_FETCH_TIMEOUT_MS = 3_000;
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TRIGGER_LOG_EVENT = 'activitypub_inbox_dispatcher_trigger' as const;
const FOLLOW_LIFECYCLE_ACTIVITY_TYPES = new Set(['Follow', 'Accept', 'Undo']);

type DispatcherJobConfig = {
  readonly projectId: string;
  readonly region: string;
  readonly jobName: string;
};

type ActivityPubDispatcherTriggerErrorCode =
  | 'missing_config'
  | 'token_unavailable'
  | 'token_timeout'
  | 'network_error'
  | 'fetch_timeout'
  | 'http_error';

/** Result of a non-throwing ActivityPub dispatcher trigger attempt from an inbox enqueue hook. */
export type ActivityPubDispatcherTriggerStatus = 'skipped' | 'started' | 'fallback';

/** Input for the inbox dispatcher trigger; only the ActivityStreams type is forwarded. */
export type ActivityPubDispatcherTriggerInput = {
  readonly activityType: string | null;
};

export type ActivityPubDispatcherTriggerDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: typeof fetch;
  readonly createAuth?: () => GoogleAuth;
  readonly getAccessToken?: (auth: GoogleAuth, timeoutMs: number) => Promise<string>;
  readonly logger?: (payload: {
    readonly event: typeof TRIGGER_LOG_EVENT;
    readonly status: 'fallback';
    readonly errorCode: ActivityPubDispatcherTriggerErrorCode;
  }) => void;
};

/**
 * Requests the ActivityPub dispatcher Cloud Run Job after a newly persisted follow-lifecycle inbox row.
 * Never throws; bounded token and API calls degrade to Scheduler fallback on any failure.
 */
export async function triggerActivityPubInboxDispatcher(
  input: ActivityPubDispatcherTriggerInput,
  deps?: ActivityPubDispatcherTriggerDeps,
): Promise<ActivityPubDispatcherTriggerStatus> {
  const env = deps?.env ?? process.env;
  if (env.ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED?.trim() !== '1') {
    return 'skipped';
  }
  if (!input.activityType || !FOLLOW_LIFECYCLE_ACTIVITY_TYPES.has(input.activityType)) {
    return 'skipped';
  }

  try {
    const config = readDispatcherJobConfig(env);
    const auth = (deps?.createAuth ?? createDefaultAuth)();
    const token = await (deps?.getAccessToken ?? getCloudAccessTokenWithTimeout)(
      auth,
      ACCESS_TOKEN_TIMEOUT_MS,
    );
    await startDispatcherJob(config, token, deps?.fetcher ?? fetch);
    return 'started';
  } catch (error) {
    logFallback(deps, classifyTriggerError(error));
    return 'fallback';
  }
}

function readDispatcherJobConfig(
  env: Readonly<Record<string, string | undefined>>,
): DispatcherJobConfig {
  return {
    projectId: requiredEnv(env, 'PUFU_LENS_GCP_PROJECT_ID'),
    region: requiredEnv(env, 'PUFU_LENS_CLOUD_RUN_JOBS_REGION'),
    jobName: requiredEnv(env, 'PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME'),
  };
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new TriggerError('missing_config');
  }
  return value;
}

class TriggerError extends Error {
  readonly code: ActivityPubDispatcherTriggerErrorCode;

  constructor(code: ActivityPubDispatcherTriggerErrorCode) {
    super(code);
    this.code = code;
  }
}

function classifyTriggerError(error: unknown): ActivityPubDispatcherTriggerErrorCode {
  if (error instanceof TriggerError) {
    return error.code;
  }
  if (error instanceof Error) {
    if (error.message === 'cloud access token timed out') {
      return 'token_timeout';
    }
    if (error.message === 'cloud access token unavailable') {
      return 'token_unavailable';
    }
    if (error.message === 'dispatcher job fetch timed out') {
      return 'fetch_timeout';
    }
    if (error.message === 'dispatcher job fetch failed') {
      return 'network_error';
    }
    if (error.message === 'dispatcher job http error') {
      return 'http_error';
    }
  }
  return 'network_error';
}

function logFallback(
  deps: ActivityPubDispatcherTriggerDeps | undefined,
  errorCode: ActivityPubDispatcherTriggerErrorCode,
): void {
  const payload = {
    event: TRIGGER_LOG_EVENT,
    status: 'fallback' as const,
    errorCode,
  };
  if (deps?.logger) {
    deps.logger(payload);
    return;
  }
  console.error(JSON.stringify(payload));
}

function createDefaultAuth(): GoogleAuth {
  return new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
}

async function getCloudAccessTokenWithTimeout(
  auth: GoogleAuth,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tokenPromise = auth.getAccessToken();
  void tokenPromise.catch(() => undefined);
  try {
    const token = await Promise.race([
      tokenPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TriggerError('token_timeout')), timeoutMs);
      }),
    ]);
    if (!token) {
      throw new TriggerError('token_unavailable');
    }
    return token;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function startDispatcherJob(
  config: DispatcherJobConfig,
  token: string,
  fetcher: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOB_RUN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(buildDispatcherJobRunUrl(config), {
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
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new TriggerError('http_error');
    }
  } catch (error) {
    if (error instanceof TriggerError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TriggerError('fetch_timeout');
    }
    throw new TriggerError('network_error');
  } finally {
    clearTimeout(timer);
  }
}

function buildDispatcherJobRunUrl(config: DispatcherJobConfig): string {
  return `https://run.googleapis.com/v2/projects/${encodeURIComponent(
    config.projectId,
  )}/locations/${encodeURIComponent(config.region)}/jobs/${encodeURIComponent(config.jobName)}:run`;
}
