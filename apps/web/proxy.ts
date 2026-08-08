import { fedifyWith } from '@fedify/next';
import { NextResponse } from 'next/server';
import { createActivityPubSpikeFederation } from './src/activitypub-runtime.ts';

type ProxyHandler = (request: Request) => unknown;

let spikeHandler: ProxyHandler | undefined;

async function resolveSpikeHandler(): Promise<ProxyHandler> {
  if (spikeHandler) {
    return spikeHandler;
  }

  if (process.env.ACTIVITYPUB_SPIKE_ENABLED !== '1') {
    spikeHandler = () => NextResponse.next();
    return spikeHandler;
  }

  try {
    const federation = await createActivityPubSpikeFederation();
    spikeHandler = fedifyWith(federation)(() => NextResponse.next());
  } catch {
    spikeHandler = () => NextResponse.next();
  }

  return spikeHandler;
}

/** Routes federation requests through the Step 1 ActivityPub spike when explicitly enabled. */
export async function proxy(request: Request) {
  const handler = await resolveSpikeHandler();
  return await handler(request);
}

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
