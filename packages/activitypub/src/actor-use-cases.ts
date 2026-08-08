import type postgres from 'postgres';
import {
  type ActivityPubRepository,
  createPostgresActivityPubRepository,
} from './actor-repository.ts';
import type {
  ActivityPubActor,
  ActivityPubInstanceConfig,
  ObjectRepresentation,
} from './schema.ts';

export type ActivityPubUseCases = {
  ensureAggregateActor(): Promise<ActivityPubActor>;
  enableProjectActor(input: {
    projectId: string;
    projectSlug: string;
    preferredUsername?: string;
  }): Promise<ActivityPubActor>;
  disableProjectActor(input: { projectId: string; projectSlug: string }): Promise<ActivityPubActor>;
  getInstanceConfig(): Promise<ActivityPubInstanceConfig>;
  updateInstanceRepresentation(
    objectRepresentation: ObjectRepresentation,
  ): Promise<ActivityPubInstanceConfig>;
};

/** Input for use cases backed by an existing repository instance. */
export type CreateActivityPubUseCasesWithRepositoryInput = {
  repository: ActivityPubRepository;
  encryptionKey: Buffer;
};

/** Input for use cases backed by a PostgreSQL connection. */
export type CreateActivityPubUseCasesWithSqlInput = {
  sql: postgres.Sql;
  encryptionKey: Buffer;
};

export type CreateActivityPubUseCasesInput =
  | CreateActivityPubUseCasesWithRepositoryInput
  | CreateActivityPubUseCasesWithSqlInput;

function resolveActivityPubRepository(
  input: CreateActivityPubUseCasesInput,
): ActivityPubRepository {
  if ('repository' in input) {
    return input.repository;
  }
  return createPostgresActivityPubRepository({
    sql: input.sql,
    encryptionKey: input.encryptionKey,
  });
}

/**
 * Creates ActivityPub use cases backed by the repository transaction boundary.
 * Project scope and visibility guards execute inside repository transactions.
 * Representation updates read the current config inside `runInTransaction`,
 * reject locked values, no-op when unchanged, and persist changes through the
 * transaction-bound repository only.
 */
export function createActivityPubUseCases(
  input: CreateActivityPubUseCasesInput,
): ActivityPubUseCases {
  const repository = resolveActivityPubRepository(input);

  return {
    ensureAggregateActor: () => repository.ensureAggregateActor(),
    enableProjectActor: (params) => repository.enableProjectActor(params),
    disableProjectActor: (params) => repository.disableProjectActor(params),
    getInstanceConfig: () => repository.getInstanceConfig(),
    updateInstanceRepresentation: async (objectRepresentation) =>
      repository.runInTransaction(async (tx) => {
        const current = await tx.getInstanceConfig();
        if (current.representationLockedAt !== null) {
          throw new Error('ActivityPub object representation is locked');
        }
        if (current.objectRepresentation === objectRepresentation) {
          return current;
        }
        return tx.updateInstanceRepresentation(objectRepresentation);
      }),
  };
}
