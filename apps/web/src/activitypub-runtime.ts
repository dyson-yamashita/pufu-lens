import { parseCanonicalOrigin } from '@pufu-lens/activitypub';
import {
  type ActivityPubReportFixture,
  createActivityPubProtocolFixture,
} from '@pufu-lens/activitypub/protocol';

const DEFAULT_SPIKE_REPORT: ActivityPubReportFixture = {
  reportId: 'spike-report',
  projectSlug: 'spike-project',
  title: 'ActivityPub Spike',
  summary: 'Step 1 local federation fixture.',
  publishedAt: new Date('2026-08-01T00:00:00.000Z'),
};

/** Step 1 web runtime surface compatible with Next.js 16 proxy conventions. */
export type ActivityPubWebRuntime = {
  runtime: 'nodejs';
  proxyConvention: 'next-16-node-runtime';
  handleRequest: (request: Request) => Promise<Response>;
};

/** Resolves the configured canonical origin and ignores untrusted request Host headers. */
export function resolveActivityPubCanonicalOrigin(input?: {
  configuredOrigin?: string;
  requestHost?: string;
}): string {
  void input?.requestHost;
  const origin = input?.configuredOrigin ?? process.env.ACTIVITYPUB_CANONICAL_ORIGIN?.trim();
  if (!origin) {
    throw new Error('canonical origin is required');
  }
  return parseCanonicalOrigin(origin).origin;
}

/** Creates the Step 1 ActivityPub web runtime spike without starting queue consumers. */
export async function createActivityPubWebRuntime(input: {
  canonicalOrigin: string;
  manuallyStartQueue: boolean;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
  preferredUsername?: string;
  report?: ActivityPubReportFixture;
}): Promise<ActivityPubWebRuntime> {
  if (!input.manuallyStartQueue) {
    throw new Error('manuallyStartQueue must be true for ActivityPub web runtime spike');
  }

  const fixture = await createActivityPubProtocolFixture({
    canonicalOrigin: input.canonicalOrigin,
    preferredUsername: input.preferredUsername ?? 'pufu',
    report: input.report ?? DEFAULT_SPIKE_REPORT,
    queueHooks: input.queueHooks,
  });

  return {
    runtime: 'nodejs',
    proxyConvention: 'next-16-node-runtime',
    handleRequest: (request: Request) => fixture.federation.fetch(request),
  };
}

/** Creates the lazy-initialized local protocol federation used by the web proxy spike. */
export async function createActivityPubSpikeFederation(input?: { canonicalOrigin?: string }) {
  const canonicalOrigin = resolveActivityPubCanonicalOrigin({
    configuredOrigin: input?.canonicalOrigin,
  });
  const fixture = await createActivityPubProtocolFixture({
    canonicalOrigin,
    preferredUsername: 'pufu',
    report: DEFAULT_SPIKE_REPORT,
  });
  return fixture.rawFederation;
}
