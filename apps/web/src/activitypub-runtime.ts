import {
  createPostgresActivityPubRepository,
  createPostgresFedifyKvStore,
  createPostgresQueueAdapter,
  createProductionActivityPubFederation,
  parseActorKeyEncryptionKey,
  parseCanonicalOrigin,
} from '@pufu-lens/activitypub';
import {
  type ActivityPubReportFixture,
  createActivityPubProtocolFixture,
} from '@pufu-lens/activitypub/protocol';
import postgres from 'postgres';

const DEFAULT_SPIKE_REPORT: ActivityPubReportFixture = {
  reportId: 'spike-report',
  projectSlug: 'spike-project',
  title: 'ActivityPub Spike',
  summary: 'Step 1 local federation fixture.',
  publishedAt: new Date('2026-08-01T00:00:00.000Z'),
};

/** Step 1/2 web runtime surface compatible with Next.js 16 proxy conventions. */
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

/** Resolves production ActivityPub runtime configuration from environment variables. */
export function resolveActivityPubProductionConfig(input?: {
  databaseUrl?: string;
  canonicalOrigin?: string;
  encryptionKey?: string;
}): {
  databaseUrl: string;
  canonicalOrigin: string;
  encryptionKey: Buffer;
} {
  const databaseUrl = input?.databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for ActivityPub production runtime');
  }
  const canonicalOrigin = resolveActivityPubCanonicalOrigin({
    configuredOrigin: input?.canonicalOrigin,
  });
  const encryptionKey = parseActorKeyEncryptionKey(
    input?.encryptionKey ?? process.env.ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY,
  );
  return { databaseUrl, canonicalOrigin, encryptionKey };
}

/** Creates the production ActivityPub web runtime without starting queue consumers. */
export async function createActivityPubProductionRuntime(input?: {
  databaseUrl?: string;
  canonicalOrigin?: string;
  encryptionKey?: string;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
}): Promise<ActivityPubWebRuntime> {
  const config = resolveActivityPubProductionConfig(input);
  const sql = postgres(config.databaseUrl, { max: 1 });
  const repository = createPostgresActivityPubRepository({
    sql,
    encryptionKey: config.encryptionKey,
  });
  const federation = await createProductionActivityPubFederation({
    canonicalOrigin: config.canonicalOrigin,
    repository,
    kv: createPostgresFedifyKvStore({ sql }),
    queue: createPostgresQueueAdapter({
      sql,
      canonicalOrigin: config.canonicalOrigin,
    }),
    queueHooks: input?.queueHooks,
  });

  return {
    runtime: 'nodejs',
    proxyConvention: 'next-16-node-runtime',
    handleRequest: (request: Request) => federation.fetch(request, { contextData: undefined }),
  };
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

/** Creates the lazy-initialized production federation used by the web proxy runtime. */
export async function createActivityPubProductionFederation(input?: {
  databaseUrl?: string;
  canonicalOrigin?: string;
  encryptionKey?: string;
}): Promise<Awaited<ReturnType<typeof createProductionActivityPubFederation>>> {
  const config = resolveActivityPubProductionConfig(input);
  const sql = postgres(config.databaseUrl, { max: 1 });
  const repository = createPostgresActivityPubRepository({
    sql,
    encryptionKey: config.encryptionKey,
  });
  return createProductionActivityPubFederation({
    canonicalOrigin: config.canonicalOrigin,
    repository,
    kv: createPostgresFedifyKvStore({ sql }),
    queue: createPostgresQueueAdapter({
      sql,
      canonicalOrigin: config.canonicalOrigin,
    }),
  });
}
