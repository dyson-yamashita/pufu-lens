import type postgres from 'postgres';
import type { GraphMutationRepository } from './index.js';
import { createPostgresAgeGraphMutationRepository } from './postgres-age-mutation.js';
import { createPostgresRelationalGraphMutationRepository } from './postgres-relational-mutation.js';
import {
  createGraphShadowMutationRepository,
  type GraphShadowObserver,
  parseGraphTransitionMode,
} from './shadow.js';

type GraphTransitionExecutor = postgres.Sql | postgres.TransactionSql;

export interface PostgresGraphTransitionMutationOptions {
  readonly observer?: GraphShadowObserver;
  readonly random?: () => number;
  readonly transitionMode?: string;
}

/**
 * Selects relational-only mutations or the legacy AGE-primary dual-write modes atomically.
 *
 * Passing a caller-owned transaction keeps retryable primary and shadow mutations atomic.
 */
export function createPostgresGraphTransitionMutationRepository(
  sql: GraphTransitionExecutor,
  options: PostgresGraphTransitionMutationOptions = {},
): GraphMutationRepository {
  const mode = parseGraphTransitionMode(
    options.transitionMode ?? process.env.PUFU_LENS_GRAPH_TRANSITION_MODE,
  );
  if (mode === 'relational-only') {
    return createPostgresRelationalGraphMutationRepository(sql);
  }
  return createGraphShadowMutationRepository({
    mode,
    observer: options.observer ?? logGraphTransitionObservation,
    primary: createPostgresAgeGraphMutationRepository(sql),
    random: options.random,
    shadow: createPostgresRelationalGraphMutationRepository(sql),
  });
}

/** Emits the already-sanitized transition observation as structured JSON. */
function logGraphTransitionObservation(observation: unknown): void {
  console.info(JSON.stringify(observation));
}
