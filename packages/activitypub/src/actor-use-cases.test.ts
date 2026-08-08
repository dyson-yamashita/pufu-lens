import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityPubRepository } from './actor-repository.ts';
import { createActivityPubUseCases } from './actor-use-cases.ts';
import type { ActivityPubActor, ActivityPubInstanceConfig } from './schema.ts';

function createMockRepository(overrides?: Partial<ActivityPubRepository>): ActivityPubRepository {
  const config: ActivityPubInstanceConfig = {
    id: 1,
    objectRepresentation: 'article',
    representationLockedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    runInTransaction: async (callback) => callback(createMockRepository(overrides)),
    ensureAggregateActor: async () => ({}) as ActivityPubActor,
    enableProjectActor: async () => ({}) as ActivityPubActor,
    disableProjectActor: async () => ({}) as ActivityPubActor,
    findRemotelyVisibleActorByUsername: async () => undefined,
    importActorCryptoKeyPair: async () => {
      throw new Error('not implemented');
    },
    findPublicReportArticle: async () => undefined,
    getInstanceConfig: async () => config,
    updateInstanceRepresentation: async (objectRepresentation) => ({
      ...config,
      objectRepresentation,
      updatedAt: new Date(),
    }),
    ...overrides,
  };
}

test('updateInstanceRepresentation rejects changes after lock in use case', async () => {
  const lockedConfig: ActivityPubInstanceConfig = {
    id: 1,
    objectRepresentation: 'article',
    representationLockedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const useCases = createActivityPubUseCases({
    encryptionKey: Buffer.alloc(32),
    repository: createMockRepository({
      getInstanceConfig: async () => lockedConfig,
    }),
  });

  await assert.rejects(() => useCases.updateInstanceRepresentation('note'), /locked/i);
});

test('updateInstanceRepresentation is idempotent for same value', async () => {
  const useCases = createActivityPubUseCases({
    encryptionKey: Buffer.alloc(32),
    repository: createMockRepository(),
  });
  const updated = await useCases.updateInstanceRepresentation('article');
  assert.equal(updated.objectRepresentation, 'article');
});
