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
