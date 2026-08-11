import type { Federation } from '@fedify/fedify';
import { exportSpki } from '@fedify/vocab-runtime';
import postgres from 'postgres';
import {
  type ActivityPubRepository,
  createPostgresActivityPubRepository,
} from '../actor-repository.ts';
import type { ActivityPubDispatcherClock } from '../dispatcher.ts';
import { createTestActivityPubFederation } from '../federation.ts';
import {
  type ActivityPubFollowUseCases,
  createActivityPubFollowUseCases,
} from '../follow-use-cases.ts';
import { createActivityPubInboundReportUseCasesWithSql } from '../inbound-report-use-cases.ts';
import {
  createPostgresFedifyKvStore,
  createPostgresQueueAdapter,
  processOneQueuedMessage,
} from '../postgres.ts';
import { runActivityPubDispatcherOnce } from '../postgres-dispatcher.ts';
import { createRemoteActorResolver } from '../remote-actor.ts';
import { createRemoteArticleResolver } from '../remote-article.ts';
import { assertActivityPubHermeticE2eRuntime } from '../test-runtime-guard.ts';
import { buildActivityPubUriContract } from '../uri-contract.ts';
import {
  createHermeticControlClient,
  type HermeticControlClient,
  tryHandleHermeticControlRoute,
} from './control-routes.ts';
import type { HermeticFaultController } from './fault-controller.ts';
import { createHermeticDocumentLoader } from './host-router.ts';
import type { HermeticTempDatabase } from './temp-databases.ts';

export type PufuLensHermeticInstance = {
  readonly label: 'a' | 'b';
  readonly origin: string;
  readonly host: string;
  readonly sql: postgres.Sql;
  readonly encryptionKey: Buffer;
  readonly actorRepository: ActivityPubRepository;
  readonly followUseCases: ActivityPubFollowUseCases;
  readonly federation: Federation<undefined>;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly reportId: string;
  readonly projectActorId: string;
  readonly aggregateActorId: string;
  readonly publicKeyPem: string;
  readonly control: HermeticControlClient;
  handleRequest(request: Request): Promise<Response>;
  drainQueue(limit?: number): Promise<{ processed: number; failed: number }>;
  runDispatcher(limit?: number): Promise<{ materialized: number; processed: number }>;
  close(): Promise<void>;
};

type CreatePufuLensInstanceInput = {
  readonly label: 'a' | 'b';
  readonly database: HermeticTempDatabase;
  readonly encryptionKeySeed: number;
  readonly faultController: HermeticFaultController;
  readonly fetchImpl?: typeof fetch;
};

const INSTANCE_CONFIG = {
  a: {
    origin: 'https://lens-a.test',
    host: 'lens-a.test',
    projectId: '70000000-0000-0000-0000-00000000000a',
    projectSlug: 'project-a',
    reportId: '70000000-0000-0000-0000-0000000000a1',
    userId: '70000000-0000-0000-0000-0000000000aa',
  },
  b: {
    origin: 'https://lens-b.test',
    host: 'lens-b.test',
    projectId: '70000000-0000-0000-0000-00000000000b',
    projectSlug: 'project-b',
    reportId: '70000000-0000-0000-0000-0000000000b1',
    userId: '70000000-0000-0000-0000-0000000000bb',
  },
} as const;

/** Creates one seeded Pufu Lens hermetic instance backed by an isolated PostgreSQL database. */
export async function createPufuLensHermeticInstance(
  input: CreatePufuLensInstanceInput,
): Promise<PufuLensHermeticInstance> {
  assertActivityPubHermeticE2eRuntime();
  const config = INSTANCE_CONFIG[input.label];
  const encryptionKey = Buffer.alloc(32, input.encryptionKeySeed);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const documentLoader = createHermeticDocumentLoader(fetchImpl);
  const sql = postgres(input.database.url, { max: 4 });
  await sql`SET search_path TO public, ag_catalog, "$user"`;
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const hermeticValidateUrl = async () => {};
  const remoteActorResolver = createRemoteActorResolver({
    canonicalOrigin: config.origin,
    fetch: fetchImpl,
    isDomainBlocked: () => false,
    validateUrl: hermeticValidateUrl,
  });
  const remoteArticleResolver = createRemoteArticleResolver({
    canonicalOrigin: config.origin,
    fetch: fetchImpl,
    isDomainBlocked: () => false,
    validateUrl: hermeticValidateUrl,
  });
  const followUseCases = createActivityPubFollowUseCases({
    canonicalOrigin: config.origin,
    sql,
    encryptionKey,
    actorRepository,
    fetch: fetchImpl,
    remoteActorResolver,
  });

  await seedInstanceData({
    sql,
    actorRepository,
    ...config,
  });

  const projectActor = await actorRepository.findRemotelyVisibleActorByUsername(config.projectSlug);
  const aggregateActor = await actorRepository.findRemotelyVisibleActorByUsername('all');
  if (!projectActor || !aggregateActor) {
    throw new Error(`Hermetic instance ${input.label} failed to seed actors`);
  }
  const keyPair = await actorRepository.importActorCryptoKeyPair(projectActor.id);
  const publicKeyPem = await exportSpki(keyPair.publicKey);

  const inboundReportUseCases = createActivityPubInboundReportUseCasesWithSql({
    canonicalOrigin: config.origin,
    sql,
    isDomainBlocked: () => false,
    fetch: fetchImpl,
    remoteArticleResolver,
  });

  const queue = createPostgresQueueAdapter({ sql, canonicalOrigin: config.origin });
  const federation = await createTestActivityPubFederation({
    canonicalOrigin: config.origin,
    repository: actorRepository,
    followUseCases,
    inboundReportUseCases,
    kv: createPostgresFedifyKvStore({
      sql,
      initialized: true,
    }),
    queue,
    allowPrivateAddress: false,
    testDocumentLoaderFactory: () => documentLoader,
    testContextLoaderFactory: () => documentLoader,
    testAuthenticatedDocumentLoaderFactory: () => documentLoader,
  });

  const hermeticClock: ActivityPubDispatcherClock = input.faultController.clock;

  const drainQueue = async (limit = 50) => {
    let processed = 0;
    let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      const result = await processOneQueuedMessage({
        sql,
        canonicalOrigin: config.origin,
        encryptionKey,
        actorRepository,
        testOnlyAllowPrivateAddress: true,
        testRemoteActorResolver: remoteActorResolver,
        testRemoteArticleResolver: remoteArticleResolver,
        testDocumentLoaderFactory: () => documentLoader,
        testDeliveryFetchTimeoutMs: 25,
        clock: hermeticClock,
      });
      if (result.status === 'no-op') {
        break;
      }
      if (result.status === 'delivery_failed') {
        failed += 1;
      } else {
        processed += 1;
      }
    }
    return { processed, failed };
  };

  const runDispatcher = async (limit = 50) => {
    let materialized = 0;
    let processed = 0;
    for (let index = 0; index < limit; index += 1) {
      const result = await runActivityPubDispatcherOnce({
        sql,
        canonicalOrigin: config.origin,
        encryptionKey,
        actorRepository,
        testOnlyAllowPrivateAddress: true,
        testRemoteActorResolver: remoteActorResolver,
        testRemoteArticleResolver: remoteArticleResolver,
        testDocumentLoaderFactory: () => documentLoader,
        testDeliveryFetchTimeoutMs: 25,
        clock: hermeticClock,
        maxBatchSize: 1,
      });
      materialized += result.activitiesMaterialized;
      processed += result.queueProcessed;
      if (result.queueProcessed === 0 && result.activitiesMaterialized === 0) {
        break;
      }
    }
    return { materialized, processed };
  };

  const instance = {
    label: input.label,
    origin: config.origin,
    host: config.host,
    sql,
    encryptionKey,
    actorRepository,
    followUseCases,
    federation,
    projectId: config.projectId,
    projectSlug: config.projectSlug,
    reportId: config.reportId,
    projectActorId: projectActor.id,
    aggregateActorId: aggregateActor.id,
    publicKeyPem,
    control: createHermeticControlClient({ origin: config.origin }),
    async handleRequest(request: Request) {
      const controlResponse = await tryHandleHermeticControlRoute(request, {
        label: input.label,
        origin: config.origin,
        sql,
        actorRepository,
        followUseCases,
        projectId: config.projectId,
        projectSlug: config.projectSlug,
        reportId: config.reportId,
        faultController: input.faultController,
        drainQueue,
        runDispatcher,
      });
      if (controlResponse) {
        return controlResponse;
      }
      return federation.fetch(request, { contextData: undefined });
    },
    drainQueue,
    runDispatcher,
    async close() {
      await sql.end({ timeout: 5 });
    },
  } satisfies PufuLensHermeticInstance;
  return instance;
}

async function seedInstanceData(input: {
  sql: postgres.Sql;
  actorRepository: ActivityPubRepository;
  projectId: string;
  projectSlug: string;
  reportId: string;
  userId: string;
}): Promise<void> {
  await input.sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (
      ${input.userId}::uuid,
      ${`${input.projectSlug}@hermetic.test`},
      ${`Hermetic ${input.projectSlug}`},
      'member'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await input.sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${input.projectId}::uuid,
      ${input.projectSlug},
      ${`Hermetic ${input.projectSlug}`},
      ${`graph_${input.projectSlug.replaceAll('-', '_')}`},
      ${input.projectSlug},
      'public'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await input.sql`
    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES (${input.projectId}::uuid, ${input.userId}::uuid, 'admin')
    ON CONFLICT DO NOTHING
  `;
  await input.sql`
    INSERT INTO public.reports (
      id,
      project_id,
      title,
      storage_uri,
      is_public,
      activitypub_public_summary
    )
    VALUES (
      ${input.reportId}::uuid,
      ${input.projectId}::uuid,
      ${`Hermetic report ${input.projectSlug}`},
      ${`hermetic://${input.projectSlug}/reports/${input.reportId}`},
      false,
      ''
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await input.actorRepository.ensureAggregateActor();
  await input.actorRepository.enableProjectActor({
    projectId: input.projectId,
    projectSlug: input.projectSlug,
  });
}

export function actorUriFor(instance: PufuLensHermeticInstance, preferredUsername: string): string {
  return buildActivityPubUriContract(instance.origin).actorUrl(preferredUsername);
}

export function actorInboxFor(
  instance: PufuLensHermeticInstance,
  preferredUsername: string,
): string {
  return buildActivityPubUriContract(instance.origin).personalInboxUrl(preferredUsername);
}
