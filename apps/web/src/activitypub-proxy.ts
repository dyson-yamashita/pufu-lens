export type ActivityPubProxyRouteKind =
  | 'webfinger'
  | 'actor'
  | 'inbox'
  | 'shared_inbox'
  | 'report'
  | 'collection'
  | 'other';

export const ACTIVITYPUB_REQUEST_EVENT = 'activitypub_request';
export const ACTIVITYPUB_INBOX_AUTHENTICATION_FAILURE_EVENT =
  'activitypub_inbox_authentication_failure';
export const ACTIVITYPUB_PROXY_OBSERVABILITY_SCHEMA_VERSION = 1;

type ActivityPubRequestObservabilityInput = {
  readonly routeKind: ActivityPubProxyRouteKind;
  readonly method: string;
  readonly status: number;
};

type ActivityPubInboxAuthenticationFailureInput = {
  readonly routeKind: 'inbox' | 'shared_inbox';
  readonly status: 401 | 403;
};

/**
 * Classifies an ActivityPub proxy request into a fixed low-cardinality route kind.
 * Uses only pathname shape and never returns host, query, identifiers, or payload data.
 */
export function classifyActivityPubProxyRouteKind(request: Request): ActivityPubProxyRouteKind {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/.well-known/webfinger') {
    return 'webfinger';
  }
  if (pathname === '/activitypub/inbox') {
    return 'shared_inbox';
  }
  if (/^\/activitypub\/actors\/[^/]+\/inbox\/?$/.test(pathname)) {
    return 'inbox';
  }
  if (/^\/activitypub\/actors\/[^/]+\/?$/.test(pathname)) {
    return 'actor';
  }
  if (/^\/activitypub\/reports\/[^/]+\/?$/.test(pathname)) {
    return 'report';
  }
  if (/^\/activitypub\/actors\/[^/]+\/(followers|following|outbox)\/?$/.test(pathname)) {
    return 'collection';
  }
  if (pathname.startsWith('/activitypub/')) {
    return 'collection';
  }
  return 'other';
}

function httpStatusClass(status: number): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return 'other';
  }
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Emits a bodyless ActivityPub request observability event for proxy traffic.
 * Never logs host, raw path, query, identifiers, headers, or body content.
 */
export function emitActivityPubRequestObservability(
  input: ActivityPubRequestObservabilityInput,
): void {
  console.log(
    JSON.stringify({
      event: ACTIVITYPUB_REQUEST_EVENT,
      bodyless: true,
      schemaVersion: ACTIVITYPUB_PROXY_OBSERVABILITY_SCHEMA_VERSION,
      routeKind: input.routeKind,
      method: input.method.toUpperCase(),
      status: input.status,
      statusClass: httpStatusClass(input.status),
    }),
  );
}

/**
 * Emits a bodyless inbox authentication failure signal for POST inbox rejections.
 * Only 401 and 403 responses are treated as authentication/signature failures.
 */
export function emitActivityPubInboxAuthenticationFailure(
  input: ActivityPubInboxAuthenticationFailureInput,
): void {
  console.log(
    JSON.stringify({
      event: ACTIVITYPUB_INBOX_AUTHENTICATION_FAILURE_EVENT,
      bodyless: true,
      schemaVersion: ACTIVITYPUB_PROXY_OBSERVABILITY_SCHEMA_VERSION,
      routeKind: input.routeKind,
      status: input.status,
    }),
  );
}

/**
 * Observes an ActivityPub proxy request boundary with bodyless request metrics.
 * The run closure may resolve the handler and invoke it; resolver failures are covered.
 * Emits status 500 when run throws, then rethrows without logging exception text.
 */
export async function observeActivityPubProxyHandler(
  request: Request,
  run: () => Response | Promise<Response>,
): Promise<Response> {
  const routeKind = classifyActivityPubProxyRouteKind(request);
  try {
    const response = await run();
    emitActivityPubRequestObservability({
      routeKind,
      method: request.method,
      status: response.status,
    });
    if (
      request.method.toUpperCase() === 'POST' &&
      (routeKind === 'inbox' || routeKind === 'shared_inbox') &&
      (response.status === 401 || response.status === 403)
    ) {
      emitActivityPubInboxAuthenticationFailure({
        routeKind,
        status: response.status as 401 | 403,
      });
    }
    return response;
  } catch (error) {
    emitActivityPubRequestObservability({
      routeKind,
      method: request.method,
      status: 500,
    });
    throw error;
  }
}

export type ActivityPubProxyEnv = {
  ACTIVITYPUB_ENABLED?: string;
  ACTIVITYPUB_SPIKE_ENABLED?: string;
};

type FederationFetchCapable = {
  fetch: (request: Request, init?: { contextData: undefined }) => Promise<Response>;
};

type ActivityPubProxyHandler = (request: Request) => Response | Promise<Response>;

type ActivityPubProxyHandlerInput<
  TFederation extends FederationFetchCapable = FederationFetchCapable,
> = {
  env?: ActivityPubProxyEnv;
  createProductionFederation?: () => Promise<TFederation>;
  createSpikeFederation?: () => Promise<TFederation>;
  wrapFederation?: (federation: TFederation) => ActivityPubProxyHandler;
  fallbackResponse?: () => Response;
};

type ActivityPubProxyHandlerResult = {
  handler: ActivityPubProxyHandler;
  cacheable: boolean;
};

/**
 * Creates a process-scoped single-flight resolver for the ActivityPub proxy handler.
 * Concurrent first requests share one initialization attempt, but only successful handlers are cached.
 * Transient 503 fallbacks and rejected configuration attempts are retried on the next resolve.
 */
export function createCachedActivityPubProxyHandlerResolver<
  TFederation extends FederationFetchCapable = FederationFetchCapable,
>(
  input: ActivityPubProxyHandlerInput<TFederation>,
): {
  resolve: () => Promise<ActivityPubProxyHandler>;
  reset: () => void;
} {
  let cached: ActivityPubProxyHandler | undefined;
  let inflight: Promise<ActivityPubProxyHandler> | undefined;

  return {
    async resolve() {
      if (cached) {
        return cached;
      }
      if (!inflight) {
        const attempt = (async () => {
          const { handler, cacheable } = await resolveActivityPubProxyHandlerResult(input);
          if (cacheable) {
            cached = handler;
          }
          return handler;
        })();
        inflight = attempt;
        try {
          return await attempt;
        } finally {
          if (inflight === attempt) {
            inflight = undefined;
          }
        }
      }
      return inflight;
    },
    reset() {
      cached = undefined;
      inflight = undefined;
    },
  };
}

/** Resolves the ActivityPub proxy handler for federation-scoped requests. */
export async function resolveActivityPubProxyHandler<
  TFederation extends FederationFetchCapable = FederationFetchCapable,
>(input?: ActivityPubProxyHandlerInput<TFederation>): Promise<ActivityPubProxyHandler> {
  const { handler } = await resolveActivityPubProxyHandlerResult(input);
  return handler;
}

async function resolveActivityPubProxyHandlerResult<
  TFederation extends FederationFetchCapable = FederationFetchCapable,
>(input?: ActivityPubProxyHandlerInput<TFederation>): Promise<ActivityPubProxyHandlerResult> {
  const env = input?.env ?? process.env;
  const createProductionFederation = input?.createProductionFederation;
  const createSpikeFederation = input?.createSpikeFederation;
  const wrapFederation =
    input?.wrapFederation ??
    ((federation: TFederation) => (request: Request) =>
      federation.fetch(request, { contextData: undefined }));
  const fallbackResponse = input?.fallbackResponse ?? (() => new Response(null, { status: 204 }));

  if (env.ACTIVITYPUB_ENABLED === '1') {
    if (!createProductionFederation) {
      throw new Error('createProductionFederation is required when ACTIVITYPUB_ENABLED=1');
    }
    try {
      const federation = await createProductionFederation();
      return { handler: wrapFederation(federation), cacheable: true };
    } catch {
      console.error('ActivityPub production runtime failed to initialize');
      return {
        handler: () => new Response('Service Unavailable', { status: 503 }),
        cacheable: false,
      };
    }
  }

  if (env.ACTIVITYPUB_SPIKE_ENABLED === '1') {
    if (!createSpikeFederation) {
      throw new Error('createSpikeFederation is required when ACTIVITYPUB_SPIKE_ENABLED=1');
    }
    try {
      const federation = await createSpikeFederation();
      return { handler: wrapFederation(federation), cacheable: true };
    } catch {
      return {
        handler: () => fallbackResponse(),
        cacheable: false,
      };
    }
  }

  return {
    handler: () => fallbackResponse(),
    cacheable: true,
  };
}
