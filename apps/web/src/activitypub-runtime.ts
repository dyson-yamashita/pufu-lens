import {
  createActivityPubFollowUseCases,
  createPostgresActivityPubRepository,
  createPostgresFedifyKvStore,
  createPostgresQueueAdapter,
  createProductionActivityPubFederation,
  parseActorKeyEncryptionKey,
  parseBlockedDomainsFromEnv,
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

const DATABASE_MAX_CONNECTIONS_PATTERN = /^(?:[1-9]|1\d|20)$/;

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

/**
 * Resolves production ActivityPub runtime configuration from environment variables.
 * `databaseMaxConnections` accepts only canonical integers 1..20 from explicit input or
 * `ACTIVITYPUB_DB_MAX_CONNECTIONS` without trimming or leading-zero normalization.
 */
export function resolveActivityPubProductionConfig(input?: {
  databaseUrl?: string;
  canonicalOrigin?: string;
  encryptionKey?: string;
  databaseMaxConnections?: number | string;
}): {
  databaseUrl: string;
  canonicalOrigin: string;
  encryptionKey: Buffer;
  databaseMaxConnections: number;
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
  const databaseMaxConnections = resolveDatabaseMaxConnections(input);
  return { databaseUrl, canonicalOrigin, encryptionKey, databaseMaxConnections };
}

function resolveDatabaseMaxConnections(input?: {
  databaseMaxConnections?: number | string;
}): number {
  const raw = input?.databaseMaxConnections ?? process.env.ACTIVITYPUB_DB_MAX_CONNECTIONS ?? '5';
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (!DATABASE_MAX_CONNECTIONS_PATTERN.test(text)) {
    throw new Error(
      'ACTIVITYPUB_DB_MAX_CONNECTIONS must be a canonical decimal integer between 1 and 20',
    );
  }
  return Number(text);
}

/** Production federation instance returned by the web proxy runtime. */
export type ActivityPubProductionFederation = Awaited<
  ReturnType<typeof createProductionActivityPubFederation>
>;

/**
 * Creates the production ActivityPub web runtime without starting queue consumers.
 * The underlying postgres pool stays open for the process lifetime; failed federation
 * initialization closes the pool before rethrowing so proxy retries cannot leak clients.
 */
export async function createActivityPubProductionRuntime(input?: {
  databaseUrl?: string;
  canonicalOrigin?: string;
  encryptionKey?: string;
  databaseMaxConnections?: number | string;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
}): Promise<ActivityPubWebRuntime> {
  const config = resolveActivityPubProductionConfig(input);
  const federation = await initializeProductionFederation({
    config,
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

/**
 * Creates the lazy-initialized production federation used by the web proxy runtime.
 * Keeps the postgres pool open on success and closes it when federation initialization fails.
 */
export async function createActivityPubProductionFederation(input?: {
  databaseUrl?: string;
  canonicalOrigin?: string;
  encryptionKey?: string;
  databaseMaxConnections?: number | string;
}): Promise<ActivityPubProductionFederation> {
  const config = resolveActivityPubProductionConfig(input);
  return initializeProductionFederation({ config });
}

/** Whether production web runtime persists Follow/Accept/Undo outbox rows (without starting consumers). */
export function resolveProductionFollowOutboxEnqueueEnabled(): boolean {
  return true;
}

async function initializeProductionFederation(input: {
  config: ReturnType<typeof resolveActivityPubProductionConfig>;
  queueHooks?: {
    listen?: () => void;
    startQueue?: () => void;
    processQueuedTask?: () => void;
  };
}): Promise<ActivityPubProductionFederation> {
  const sql = postgres(input.config.databaseUrl, { max: input.config.databaseMaxConnections });
  try {
    const repository = createPostgresActivityPubRepository({
      sql,
      encryptionKey: input.config.encryptionKey,
    });
    const followUseCases = createActivityPubFollowUseCases({
      canonicalOrigin: input.config.canonicalOrigin,
      sql,
      encryptionKey: input.config.encryptionKey,
      actorRepository: repository,
      enqueueOutbox: resolveProductionFollowOutboxEnqueueEnabled(),
      isDomainBlocked: parseBlockedDomainsFromEnv(process.env.ACTIVITYPUB_BLOCKED_DOMAINS),
    });
    return await createProductionActivityPubFederation({
      canonicalOrigin: input.config.canonicalOrigin,
      repository,
      followUseCases,
      kv: createPostgresFedifyKvStore({ sql }),
      queue: createPostgresQueueAdapter({
        sql,
        canonicalOrigin: input.config.canonicalOrigin,
      }),
      queueHooks: input.queueHooks,
    });
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
}
