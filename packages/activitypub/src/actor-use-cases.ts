import type postgres from 'postgres';
import { normalizeActivityPubActorProfile } from './actor-profile.ts';
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
  /** Returns the aggregate `@all` actor row, or undefined when no aggregate actor exists. */
  findAggregateActor(): Promise<ActivityPubActor | undefined>;
  /** Returns the project actor for `projectId`, or undefined when no project actor exists. */
  findProjectActorByProjectId(projectId: string): Promise<ActivityPubActor | undefined>;
  /**
   * Normalizes profile input and updates the aggregate actor.
   * Rejects with {@link ActivityPubActorNotFoundError} when the aggregate actor is missing.
   */
  updateAggregateActorProfile(input: {
    displayName: string;
    iconUrl?: string | null;
    additionalPrompt?: string | null;
  }): Promise<ActivityPubActor>;
  /**
   * Sets aggregate federation enabled state, creating the aggregate actor when missing.
   */
  setAggregateActorEnabled(enabled: boolean): Promise<ActivityPubActor>;
  /**
   * Normalizes profile input, validates project scope (`projectId` / `projectSlug`), and updates the project actor.
   * Rejects with {@link ActivityPubActorNotFoundError} when the project actor is missing.
   */
  updateProjectActorProfile(input: {
    projectId: string;
    projectSlug: string;
    displayName: string;
    iconUrl?: string | null;
    additionalPrompt?: string | null;
  }): Promise<ActivityPubActor>;
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
 * Returned profile updates are normalized; missing aggregate/project actors reject with
 * {@link ActivityPubActorNotFoundError}; project profile updates validate transactional
 * project scope; aggregate enable-state mutation creates the aggregate actor when absent.
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
    findAggregateActor: () => repository.findAggregateActor(),
    findProjectActorByProjectId: (projectId) => repository.findProjectActorByProjectId(projectId),
    updateAggregateActorProfile: (params) =>
      repository.updateAggregateActorProfile(normalizeActivityPubActorProfile(params)),
    setAggregateActorEnabled: (enabled) => repository.setAggregateActorEnabled(enabled),
    updateProjectActorProfile: (params) =>
      repository.updateProjectActorProfile({
        projectId: params.projectId,
        projectSlug: params.projectSlug,
        ...normalizeActivityPubActorProfile(params),
      }),
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
