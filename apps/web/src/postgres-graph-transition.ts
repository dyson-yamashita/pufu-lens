import type { GraphMutationRepository, GraphReadRepository } from '@pufu-lens/graph';
import { createPostgresRelationalGraphReadRepository } from '@pufu-lens/graph/postgres-relational-read';
import { createPostgresGraphTransitionMutationRepository as createPackageMutationRepository } from '@pufu-lens/graph/postgres-transition-mutation';
import {
  createGraphPrimaryReadRepository,
  createGraphShadowReadRepository,
  type GraphPrimaryReadObservation,
  type GraphShadowObservation,
  parseGraphTransitionMode,
} from '@pufu-lens/graph/shadow';
import type postgres from 'postgres';
import { createPostgresAgeGraphReadRepository } from './postgres-graph-read-adapter.ts';

type GraphTransitionExecutor = postgres.Sql | postgres.TransactionSql;

export interface PostgresGraphTransitionOptions {
  /** Receives sanitized primary-read or shadow events; observer failures do not affect reads. */
  readonly observer?: (
    observation: GraphPrimaryReadObservation | GraphShadowObservation,
  ) => Promise<void> | void;
  readonly random?: () => number;
  readonly transitionMode?: string;
}

/** Selects server-owned routing; relational-only disables AGE reads and writes together. */
export function createPostgresGraphTransitionReadRepository(
  sql: postgres.Sql,
  options: PostgresGraphTransitionOptions = {},
): GraphReadRepository {
  const mode = parseGraphTransitionMode(
    options.transitionMode ?? process.env.PUFU_LENS_GRAPH_TRANSITION_MODE,
  );
  if (mode === 'relational-primary' || mode === 'relational-only') {
    return createGraphPrimaryReadRepository({
      primary: createPostgresRelationalGraphReadRepository(sql, { strictUnavailable: true }),
      fallback:
        mode === 'relational-primary' ? createPostgresAgeGraphReadRepository(sql) : undefined,
      observer: options.observer ?? logGraphTransitionObservation,
    });
  }
  return createGraphShadowReadRepository({
    mode,
    observer: options.observer ?? logGraphTransitionObservation,
    primary: createPostgresAgeGraphReadRepository(sql),
    random: options.random,
    shadow: createPostgresRelationalGraphReadRepository(sql),
  });
}

/** Selects relational-only mutations or legacy AGE-primary writes using the same read mode. */
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

/** Emits the already-sanitized transition observation as structured JSON. */
function logGraphTransitionObservation(observation: unknown): void {
  console.info(JSON.stringify(observation));
}
