import type { GraphMutationRepository, GraphReadRepository } from '@pufu-lens/graph';
import { createPostgresRelationalGraphReadRepository } from '@pufu-lens/graph/postgres-relational-read';
import { createPostgresGraphTransitionMutationRepository as createPackageMutationRepository } from '@pufu-lens/graph/postgres-transition-mutation';
import {
  createGraphShadowReadRepository,
  type GraphShadowObserver,
  parseGraphTransitionMode,
} from '@pufu-lens/graph/shadow';
import type postgres from 'postgres';
import { createPostgresAgeGraphReadRepository } from './postgres-graph-read-adapter.ts';

type GraphTransitionExecutor = postgres.Sql | postgres.TransactionSql;

export interface PostgresGraphTransitionOptions {
  readonly observer?: GraphShadowObserver;
  readonly random?: () => number;
  readonly transitionMode?: string;
}

/** Creates the AGE-primary graph reader with deployment-controlled relational shadow reads. */
export function createPostgresGraphTransitionReadRepository(
  sql: postgres.Sql,
  options: PostgresGraphTransitionOptions = {},
): GraphReadRepository {
  return createGraphShadowReadRepository({
    mode: parseGraphTransitionMode(
      options.transitionMode ?? process.env.PUFU_LENS_GRAPH_TRANSITION_MODE,
    ),
    observer: options.observer ?? logGraphTransitionObservation,
    primary: createPostgresAgeGraphReadRepository(sql),
    random: options.random,
    shadow: createPostgresRelationalGraphReadRepository(sql),
  });
}

/** Creates AGE-primary graph mutations with deployment-controlled relational dual-write. */
export function createPostgresGraphTransitionMutationRepository(
  sql: GraphTransitionExecutor,
  options: PostgresGraphTransitionOptions = {},
): GraphMutationRepository {
  return createPackageMutationRepository(sql, {
    observer: options.observer ?? logGraphTransitionObservation,
    random: options.random,
    transitionMode: options.transitionMode ?? process.env.PUFU_LENS_GRAPH_TRANSITION_MODE,
  });
}

function logGraphTransitionObservation(observation: unknown): void {
  console.info(JSON.stringify(observation));
}
