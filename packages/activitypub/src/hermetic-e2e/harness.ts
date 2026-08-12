import { HermeticFaultController } from './fault-controller.ts';
import { createHermeticCombinedLoader, createHostRouter } from './host-router.ts';
import { MastodonHermeticFixture } from './mastodon-fixture.ts';
import { ProtocolTraceCollector } from './protocol-trace.ts';
import {
  actorInboxFor,
  actorUriFor,
  createPufuLensHermeticInstance,
  type PufuLensHermeticInstance,
} from './pufu-context.ts';
import { createHermeticTempDatabasePair, dropHermeticTempDatabases } from './temp-databases.ts';

export type HermeticE2EHarness = {
  readonly lensA: PufuLensHermeticInstance;
  readonly lensB: PufuLensHermeticInstance;
  readonly mastodon: MastodonHermeticFixture;
  readonly faultController: HermeticFaultController;
  readonly trace: ProtocolTraceCollector;
  close(): Promise<void>;
};

/** Boots the full hermetic ActivityPub E2E harness with isolated databases and host routing. */
export async function createHermeticE2EHarness(databaseUrl: string): Promise<HermeticE2EHarness> {
  const trace = new ProtocolTraceCollector();
  const faultController = new HermeticFaultController();
  const databases = await createHermeticTempDatabasePair(databaseUrl);
  let lensA: PufuLensHermeticInstance | undefined;
  let lensB: PufuLensHermeticInstance | undefined;
  let restoreFetch: (() => void) | undefined;
  try {
    const router = createHostRouter();
    restoreFetch = router.install({ faultController, trace });
    const routedFetch = ((input, init) => router.fetch(input, init)) as typeof fetch;
    const documentLoader = createHermeticCombinedLoader(routedFetch);
    const mastodon = await MastodonHermeticFixture.create(trace, documentLoader);
    lensA = await createPufuLensHermeticInstance({
      label: 'a',
      database: databases.lensA,
      encryptionKeySeed: 11,
      faultController,
      fetchImpl: routedFetch,
    });
    lensB = await createPufuLensHermeticInstance({
      label: 'b',
      database: databases.lensB,
      encryptionKeySeed: 22,
      faultController,
      fetchImpl: routedFetch,
    });
    const createdLensA = lensA;
    const createdLensB = lensB;

    router.register(createdLensA.host, (request) => createdLensA.handleRequest(request));
    router.register(createdLensB.host, (request) => createdLensB.handleRequest(request));
    router.register('mastodon.test', (request) => mastodon.handleRequest(request));
    // Keep DB rows created with PostgreSQL now() immediately due under the injected virtual clock.
    faultController.advance(60_000);

    return {
      lensA: createdLensA,
      lensB: createdLensB,
      mastodon,
      faultController,
      trace,
      async close() {
        restoreFetch?.();
        try {
          await Promise.allSettled([createdLensA.close(), createdLensB.close()]);
          await dropHermeticTempDatabases(databases.adminSql, [
            databases.lensA.name,
            databases.lensB.name,
          ]);
        } finally {
          await databases.adminSql.end({ timeout: 5 });
        }
      },
    };
  } catch (error) {
    restoreFetch?.();
    await Promise.allSettled([lensA?.close(), lensB?.close()]);
    await dropHermeticTempDatabases(databases.adminSql, [
      databases.lensA.name,
      databases.lensB.name,
    ]).catch(() => undefined);
    await databases.adminSql.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
}

/**
 * Drains queued inbox/outbox messages across the given instances until no progress remains.
 * Runs at most `maxRounds` drain cycles with a per-round limit of 5 messages per instance.
 */
export async function drainAllQueues(
  instances: readonly PufuLensHermeticInstance[],
  maxRounds = 100,
): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    let progressed = false;
    for (const instance of instances) {
      const result = await instance.drainQueue(5);
      if (result.processed > 0 || result.failed > 0) {
        progressed = true;
      }
    }
    if (!progressed) {
      break;
    }
  }
}

/**
 * Requests an outbound follow from `source` to `target` and drains both instances until idle.
 * `targetUsername` must be a remotely visible actor on the target instance.
 */
export async function runFollowCycle(input: {
  source: PufuLensHermeticInstance;
  target: PufuLensHermeticInstance;
  targetUsername: 'project-a' | 'project-b' | 'all';
}): Promise<void> {
  const remoteAddress = `acct:${input.targetUsername}@${input.target.host}`;
  const followResponse = await input.source.control.follow({
    projectSlug: input.source.projectSlug,
    localActorPreferredUsername: input.source.projectSlug,
    remoteActorAddress: remoteAddress,
  });
  if (!followResponse.ok) {
    throw new Error(`follow failed: ${await followResponse.text()}`);
  }
  await drainAllQueues([input.source, input.target]);
}

export { actorInboxFor, actorUriFor };
