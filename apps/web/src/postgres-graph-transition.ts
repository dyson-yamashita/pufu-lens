import type { GraphMutationRepository, GraphReadRepository } from '@pufu-lens/graph';
import { createPostgresRelationalGraphReadRepository } from '@pufu-lens/graph/postgres-relational-read';
import { createPostgresGraphTransitionMutationRepository as createPackageMutationRepository } from '@pufu-lens/graph/postgres-transition-mutation';
import {
  createGraphPrimaryReadRepository,
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

/** Selects server-owned read routing; relational-primary retains AGE fallback and dual writes. */
export function createPostgresGraphTransitionReadRepository(
  sql: postgres.Sql,
  options: PostgresGraphTransitionOptions = {},
): GraphReadRepository {
  const mode = parseGraphTransitionMode(
    options.transitionMode ?? process.env.PUFU_LENS_GRAPH_TRANSITION_MODE,
  );
  if (mode === 'relational-primary') {
    return createGraphPrimaryReadRepository({
      primary: createPostgresRelationalGraphReadRepository(sql, { strictUnavailable: true }),
      fallback: createPostgresAgeGraphReadRepository(sql),
      observer: logGraphTransitionObservation,
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

/** Emits the already-sanitized transition observation as structured JSON. */
function logGraphTransitionObservation(observation: unknown): void {
  console.info(JSON.stringify(observation));
}
