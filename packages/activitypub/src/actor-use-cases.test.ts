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
  let updateCalls = 0;
  let transactionCalls = 0;
  const useCases = createActivityPubUseCases({
    encryptionKey: Buffer.alloc(32),
    repository: createMockRepository({
      runInTransaction: async (callback) => {
        transactionCalls += 1;
        return callback(createMockRepository());
      },
      updateInstanceRepresentation: async (objectRepresentation) => {
        updateCalls += 1;
        return {
          id: 1,
          objectRepresentation,
          representationLockedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    }),
  });
  const updated = await useCases.updateInstanceRepresentation('article');
  assert.equal(updated.objectRepresentation, 'article');
  assert.equal(updateCalls, 0);
  assert.equal(transactionCalls, 1);
});

test('updateInstanceRepresentation uses transaction repository for changes', async () => {
  let rootGetCalls = 0;
  let rootUpdateCalls = 0;
  let transactionGetCalls = 0;
  let transactionUpdateCalls = 0;
  const articleConfig: ActivityPubInstanceConfig = {
    id: 1,
    objectRepresentation: 'article',
    representationLockedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const noteConfig: ActivityPubInstanceConfig = {
    ...articleConfig,
    objectRepresentation: 'note',
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  };

  const useCases = createActivityPubUseCases({
    encryptionKey: Buffer.alloc(32),
    repository: createMockRepository({
      getInstanceConfig: async () => {
        rootGetCalls += 1;
        throw new Error('root getInstanceConfig must not be called');
      },
      updateInstanceRepresentation: async () => {
        rootUpdateCalls += 1;
        throw new Error('root updateInstanceRepresentation must not be called');
      },
      runInTransaction: async (callback) =>
        callback(
          createMockRepository({
            getInstanceConfig: async () => {
              transactionGetCalls += 1;
              return articleConfig;
            },
            updateInstanceRepresentation: async (objectRepresentation) => {
              transactionUpdateCalls += 1;
              return {
                ...noteConfig,
                objectRepresentation,
              };
            },
          }),
        ),
    }),
  });

  const updated = await useCases.updateInstanceRepresentation('note');
  assert.equal(updated.objectRepresentation, 'note');
  assert.equal(rootGetCalls, 0);
  assert.equal(rootUpdateCalls, 0);
  assert.equal(transactionGetCalls, 1);
  assert.equal(transactionUpdateCalls, 1);
});
