import type { GraphReadRepository } from './index.js';
import { GraphReadUnavailableError, isReadUnavailableError } from './postgres-relational-common.js';

/** Each backend has a 6s response deadline (at most 12s total); SQL retains its 5s timeout. */
export const GRAPH_PRIMARY_READ_TIMEOUT_MS = 6_000;

export interface GraphPrimaryReadObservation {
  readonly event: 'graph_primary_read_observation';
  readonly operation: keyof GraphReadRepository;
  readonly outcome: 'success' | 'fallback_success' | 'unavailable' | 'rejected';
  readonly reason: 'none' | 'unavailable' | 'timeout';
  readonly primaryProvider: 'postgres_relational';
  readonly fallbackProvider: 'postgres_age';
  readonly primaryLatencyMs: number;
  readonly fallbackLatencyMs: number;
}

interface Options {
  readonly primary: GraphReadRepository;
  readonly fallback: GraphReadRepository;
  readonly observer?: (observation: GraphPrimaryReadObservation) => void | Promise<void>;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
}

/**
 * Reads relational data first, using AGE once only on normalized unavailability or timeout.
 * Callers must authorize and validate project scope before entering this repository. Successful
 * empty results are authoritative; unexpected/validation/permission errors are never retried.
 * Dual failure returns related-document unavailable, or throws a fixed unavailable error for
 * counts/presets. Deadlines bound responses, not cancellation of in-flight database work.
 */
export function createGraphPrimaryReadRepository(options: Options): GraphReadRepository {
  async function execute<T>(
    operation: keyof GraphReadRepository,
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
    unavailable: (result: T) => boolean = () => false,
  ): Promise<T> {
    const started = Date.now();
    let primaryLatencyMs = 0;
    let fallbackStarted = 0;
    let reason: GraphPrimaryReadObservation['reason'] = 'none';
    function observe(outcome: GraphPrimaryReadObservation['outcome']): void {
      try {
        // A stalled or rejected telemetry sink must not extend the read deadline.
        void Promise.resolve(
          options.observer?.({
            event: 'graph_primary_read_observation',
            operation,
            outcome,
            reason,
            primaryProvider: 'postgres_relational',
            fallbackProvider: 'postgres_age',
            primaryLatencyMs,
            fallbackLatencyMs: fallbackStarted ? Math.max(0, Date.now() - fallbackStarted) : 0,
          }),
        ).catch(() => {});
      } catch {
        /* Observations never change read behavior. */
      }
    }
    try {
      const result = await deadline(primary, options);
      primaryLatencyMs = Math.max(0, Date.now() - started);
      if (!unavailable(result)) {
        observe('success');
        return result;
      }
      reason = 'unavailable';
    } catch (error) {
      primaryLatencyMs = Math.max(0, Date.now() - started);
      if (!(error instanceof ReadTimeoutError) && !isReadUnavailableError(error)) {
        observe('rejected');
        throw error;
      }
      reason = error instanceof ReadTimeoutError ? 'timeout' : 'unavailable';
    }
    fallbackStarted = Date.now();
    try {
      const result = await deadline(fallback, options);
      if (unavailable(result)) throw new GraphReadUnavailableError();
      observe('fallback_success');
      return result;
    } catch {
      observe('unavailable');
      throw new GraphReadUnavailableError();
    }
  }
  return {
    countDocumentNode: (input) =>
      execute(
        'countDocumentNode',
        () => options.primary.countDocumentNode(input),
        () => options.fallback.countDocumentNode(input),
      ),
    countRelations: (input) =>
      execute(
        'countRelations',
        () => options.primary.countRelations(input),
        () => options.fallback.countRelations(input),
      ),
    readPreset: (input) =>
      execute(
        'readPreset',
        () => options.primary.readPreset(input),
        () => options.fallback.readPreset(input),
      ),
    async findRelatedDocuments(input) {
      try {
        return await execute(
          'findRelatedDocuments',
          () => options.primary.findRelatedDocuments(input),
          () => options.fallback.findRelatedDocuments(input),
          (result) => result.status === 'unavailable',
        );
      } catch (error) {
        if (isReadUnavailableError(error)) return { candidates: [], status: 'unavailable' };
        throw error;
      }
    },
  };
}

class ReadTimeoutError extends Error {}

/** Bounds a backend response and consumes late rejections without cancelling a shared SQL pool. */
async function deadline<T>(operation: () => Promise<T>, options: Options): Promise<T> {
  const schedule = options.scheduleTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    options.cancelTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let handle: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = schedule(() => reject(new ReadTimeoutError()), GRAPH_PRIMARY_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    cancel(handle);
  }
}
