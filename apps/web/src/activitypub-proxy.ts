export type ActivityPubProxyEnv = {
  ACTIVITYPUB_ENABLED?: string;
  ACTIVITYPUB_SPIKE_ENABLED?: string;
};

type FederationLike = {
  fetch: (request: Request, init?: { contextData: undefined }) => Promise<Response>;
};

type ActivityPubProxyHandler = (request: Request) => unknown;

type ActivityPubProxyHandlerInput = {
  env?: ActivityPubProxyEnv;
  createProductionFederation?: () => Promise<FederationLike>;
  createSpikeFederation?: () => Promise<FederationLike>;
  wrapFederation?: (federation: FederationLike) => (request: Request) => unknown;
  fallbackResponse?: () => Response;
};

/**
 * Creates a process-scoped single-flight resolver for the ActivityPub proxy handler.
 * Concurrent first requests share one initialization promise.
 */
export function createCachedActivityPubProxyHandlerResolver(input: ActivityPubProxyHandlerInput): {
  resolve: () => Promise<ActivityPubProxyHandler>;
  reset: () => void;
} {
  let inflight: Promise<ActivityPubProxyHandler> | undefined;
  return {
    async resolve() {
      inflight ??= resolveActivityPubProxyHandler(input);
      return inflight;
    },
    reset() {
      inflight = undefined;
    },
  };
}

/** Resolves the ActivityPub proxy handler for federation-scoped requests. */
export async function resolveActivityPubProxyHandler(
  input?: ActivityPubProxyHandlerInput,
): Promise<ActivityPubProxyHandler> {
  const env = input?.env ?? process.env;
  const createProductionFederation = input?.createProductionFederation;
  const createSpikeFederation = input?.createSpikeFederation;
  const wrapFederation =
    input?.wrapFederation ??
    ((federation: FederationLike) => (request: Request) =>
      federation.fetch(request, { contextData: undefined }));
  const fallbackResponse = input?.fallbackResponse ?? (() => new Response(null, { status: 204 }));

  if (env.ACTIVITYPUB_ENABLED === '1') {
    if (!createProductionFederation) {
      throw new Error('createProductionFederation is required when ACTIVITYPUB_ENABLED=1');
    }
    try {
      const federation = await createProductionFederation();
      return wrapFederation(federation);
    } catch {
      console.error('ActivityPub production runtime failed to initialize');
      return () => new Response('Service Unavailable', { status: 503 });
    }
  }

  if (env.ACTIVITYPUB_SPIKE_ENABLED === '1') {
    if (!createSpikeFederation) {
      throw new Error('createSpikeFederation is required when ACTIVITYPUB_SPIKE_ENABLED=1');
    }
    try {
      const federation = await createSpikeFederation();
      return wrapFederation(federation);
    } catch {
      return () => fallbackResponse();
    }
  }

  return () => fallbackResponse();
}
