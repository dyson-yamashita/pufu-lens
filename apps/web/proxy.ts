import { fedifyWith } from '@fedify/next';
import { NextResponse } from 'next/server';
import { createCachedActivityPubProxyHandlerResolver } from './src/activitypub-proxy.ts';
import {
  createActivityPubProductionFederation,
  createActivityPubSpikeFederation,
} from './src/activitypub-runtime.ts';

const proxyHandlerResolver = createCachedActivityPubProxyHandlerResolver({
  createProductionFederation: createActivityPubProductionFederation,
  createSpikeFederation: createActivityPubSpikeFederation,
  wrapFederation: (federation) => fedifyWith(federation)(() => NextResponse.next()),
  fallbackResponse: () => NextResponse.next(),
});

/** Routes federation requests through production ActivityPub or the Step 1 spike when enabled. */
export async function proxy(request: Request) {
  const handler = await proxyHandlerResolver.resolve();
  return await handler(request);
}

export {
  type ActivityPubProxyEnv,
  createCachedActivityPubProxyHandlerResolver,
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
