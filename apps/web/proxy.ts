import { fedifyWith } from '@fedify/next';
import { NextResponse } from 'next/server';
import {
  createCachedActivityPubProxyHandlerResolver,
  observeActivityPubProxyHandler,
} from './src/activitypub-proxy.ts';
import {
  type ActivityPubProductionFederation,
  createActivityPubProductionFederation,
  createActivityPubSpikeFederation,
} from './src/activitypub-runtime.ts';

const proxyHandlerResolver =
  createCachedActivityPubProxyHandlerResolver<ActivityPubProductionFederation>({
    createProductionFederation: createActivityPubProductionFederation,
    createSpikeFederation: createActivityPubSpikeFederation,
    wrapFederation: (federation) =>
      fedifyWith(federation, () => undefined)(() => NextResponse.next()),
    fallbackResponse: () => NextResponse.next(),
  });

/** Routes federation requests through production ActivityPub or the Step 1 spike when enabled. */
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
  resolveActivityPubProxyHandler,
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
