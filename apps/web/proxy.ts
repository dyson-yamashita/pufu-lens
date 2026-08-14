import { fedifyWith } from '@fedify/next';
import { NextResponse } from 'next/server';
import {
  createCachedActivityPubProxyHandlerResolver,
  observeActivityPubProxyHandler,
  wrapActivityPubHandlerWithCanonicalRequest,
} from './src/activitypub-proxy.ts';
import {
  type ActivityPubProductionFederation,
  createActivityPubProductionFederation,
  createActivityPubSpikeFederation,
  resolveActivityPubCanonicalOrigin,
} from './src/activitypub-runtime.ts';

const proxyHandlerResolver =
  createCachedActivityPubProxyHandlerResolver<ActivityPubProductionFederation>({
    createProductionFederation: createActivityPubProductionFederation,
    createSpikeFederation: createActivityPubSpikeFederation,
    wrapFederation: (federation) => {
      const canonicalOrigin = resolveActivityPubCanonicalOrigin();
      const fedifyHandler = fedifyWith(federation, () => undefined)(() => NextResponse.next());
      return wrapActivityPubHandlerWithCanonicalRequest(canonicalOrigin, fedifyHandler);
    },
    fallbackResponse: () => NextResponse.next(),
  });

/**
 * Routes federation requests through production ActivityPub or the Step 1 spike when enabled.
 * The boundary emits bodyless ActivityPub request observability and records status 500 before
 * rethrowing resolver or handler exceptions.
 */
export async function proxy(request: Request): Promise<Response> {
  return observeActivityPubProxyHandler(request, async () => {
    const handler = await proxyHandlerResolver.resolve();
    return handler(request);
  });
}

export {
  ACTIVITYPUB_INBOX_AUTHENTICATION_FAILURE_EVENT,
  ACTIVITYPUB_PROXY_OBSERVABILITY_SCHEMA_VERSION,
  ACTIVITYPUB_REQUEST_EVENT,
  type ActivityPubProxyEnv,
  type ActivityPubProxyRouteKind,
  classifyActivityPubProxyRouteKind,
  createCachedActivityPubProxyHandlerResolver,
  emitActivityPubInboxAuthenticationFailure,
  emitActivityPubRequestObservability,
  observeActivityPubProxyHandler,
  rebuildActivityPubCanonicalRequest,
  resolveActivityPubProxyHandler,
  wrapActivityPubHandlerWithCanonicalRequest,
} from './src/activitypub-proxy.ts';

export const config = {
  matcher: [
    {
      source: '/:path*',
      has: [
        {
          type: 'header',
          key: 'Accept',
          value: '.*application\\/((jrd|activity|ld)\\+json|xrd\\+xml).*',
        },
      ],
    },
    {
      source: '/:path*',
      has: [
        {
          type: 'header',
          key: 'content-type',
          value: '.*application\\/((jrd|activity|ld)\\+json|xrd\\+xml).*',
        },
      ],
    },
    { source: '/.well-known/webfinger' },
    { source: '/activitypub/:path*' },
  ],
};
