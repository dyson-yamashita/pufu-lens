import type { KeywordCandidateRepository, RankedChunkCandidate } from './index.js';

/** Deployment-level keyword routing modes; the safe default keeps PGroonga primary. */
export type KeywordTransitionMode = 'pgroonga-primary' | 'pgroonga-shadow' | 'portable-primary';

/** Providers that may participate in the GCP keyword transition. */
export type KeywordTransitionProvider = 'pgroonga' | 'portable';

/** Finite categories used for identity-free shadow comparison metrics. */
export type KeywordTransitionMismatchCategory =
  | 'candidate_count'
  | 'candidate_set'
  | 'rank'
  | 'snippet_provenance';

/** Outcomes emitted by keyword transition wrappers without query or content data. */
export type KeywordTransitionOutcome =
  | 'fallback_success'
  | 'mismatch'
  | 'rejected'
  | 'shadow_error'
  | 'shadow_timeout'
  | 'success'
  | 'unavailable';

/** Sanitized keyword transition event suitable for structured application logs. */
export interface KeywordTransitionObservation {
  readonly capability: 'keyword';
  readonly event: 'keyword_transition_observation';
  readonly fallbackCandidateCount?: number;
  readonly fallbackLatencyMs: number;
  readonly fallbackProvider: KeywordTransitionProvider | 'none';
  readonly mismatchCategories: readonly KeywordTransitionMismatchCategory[];
  readonly mode: KeywordTransitionMode;
  readonly operation: 'search';
  readonly outcome: KeywordTransitionOutcome;
  readonly primaryCandidateCount?: number;
  readonly primaryLatencyMs: number;
  readonly primaryProvider: KeywordTransitionProvider;
  readonly reason: 'fallback_error' | 'none' | 'primary_error' | 'query_rejected';
  readonly shadowCandidateCount?: number;
  readonly shadowLatencyMs: number;
  readonly shadowProvider: KeywordTransitionProvider | 'none';
}

/** Receives allowlisted keyword transition observations. Observer failures are ignored. */
export type KeywordTransitionObserver = (
  observation: KeywordTransitionObservation,
) => Promise<void> | void;

/** Runtime hooks kept injectable so transition behavior can be tested without a clock or timer. */
export interface KeywordTransitionRuntimeOptions {
  readonly cancelTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
  readonly observer?: KeywordTransitionObserver;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
}

/** Provider-neutral repositories and server-owned mode used to compose keyword transition behavior. */
export interface KeywordTransitionRepositoryOptions extends KeywordTransitionRuntimeOptions {
  readonly mode: KeywordTransitionMode;
  /** Current PGroonga repository, used as primary or fallback according to `mode`. */
  readonly pgroonga: KeywordCandidateRepository;
  /** Portable LIKE / pg_trgm repository used for explicit shadow or primary evaluation. */
  readonly portable: KeywordCandidateRepository;
}

/** Outer deadline for transition reads; the portable SQL adapter keeps its own 5s statement timeout. */
export const KEYWORD_TRANSITION_TIMEOUT_MS = 6_000;

/** Fixed error returned when neither the selected provider nor its fallback is available. */
export class KeywordCandidateUnavailableError extends Error {
  constructor() {
    super('Keyword candidate capability unavailable.');
    this.name = 'KeywordCandidateUnavailableError';
  }
}

/** Marks validation failures that must not be retried through a different keyword provider. */
export class KeywordQueryRejectedError extends Error {
  constructor(message = 'Keyword query rejected.') {
    super(message);
    this.name = 'KeywordQueryRejectedError';
  }
}

/** Parses the server-owned keyword profile and fails closed on unknown values. */
export function parseKeywordTransitionMode(value: string | undefined): KeywordTransitionMode {
  const normalized = value?.trim();
  if (!normalized || normalized === 'pgroonga-primary') {
    return 'pgroonga-primary';
  }
  if (normalized === 'pgroonga-shadow' || normalized === 'portable-primary') {
    return normalized;
  }
  throw new Error('Invalid keyword transition mode.');
}

/**
 * Creates the explicit keyword transition wrapper used by evaluation and deployment composition.
 * A successful empty result is authoritative; only provider errors/timeouts can activate fallback.
 *
 * @param options - Provider repositories, server-owned mode, and optional sanitized observer
 * @returns The repository selected by the deployment-level keyword transition mode
 */
export function createKeywordTransitionRepository(
  options: KeywordTransitionRepositoryOptions,
): KeywordCandidateRepository {
  if (options.mode === 'pgroonga-primary') {
    return options.pgroonga;
  }
  if (options.mode === 'pgroonga-shadow') {
    return createShadowRepository(options);
  }
  return createPortablePrimaryRepository(options);
}

function createShadowRepository(
  options: KeywordTransitionRepositoryOptions,
): KeywordCandidateRepository {
  const runtime = createRuntime(options);
  return {
    async search(input) {
      const primaryStartedAt = runtime.now();
      let primaryResult: readonly RankedChunkCandidate[];
      try {
        primaryResult = await options.pgroonga.search(input);
      } catch (error) {
        notify(
          runtime,
          buildObservation(options.mode, {
            mismatchCategories: [],
            outcome: error instanceof KeywordQueryRejectedError ? 'rejected' : 'unavailable',
            primaryLatencyMs: elapsed(runtime, primaryStartedAt),
            primaryProvider: 'pgroonga',
            reason: error instanceof KeywordQueryRejectedError ? 'query_rejected' : 'primary_error',
          }),
        );
        throw error;
      }
      const primaryLatencyMs = elapsed(runtime, primaryStartedAt);
      const shadowStartedAt = runtime.now();
      try {
        const shadowResult = await withTimeout(() => options.portable.search(input), runtime);
        const comparison = compareCandidates(primaryResult, shadowResult);
        notify(
          runtime,
          buildObservation(options.mode, {
            mismatchCategories: comparison,
            outcome: comparison.length === 0 ? 'success' : 'mismatch',
            primaryCandidateCount: primaryResult.length,
            primaryLatencyMs,
            primaryProvider: 'pgroonga',
            shadowCandidateCount: shadowResult.length,
            shadowLatencyMs: elapsed(runtime, shadowStartedAt),
            shadowProvider: 'portable',
          }),
        );
      } catch (error) {
        notify(
          runtime,
          buildObservation(options.mode, {
            mismatchCategories: [],
            outcome:
              error instanceof KeywordTransitionTimeoutError ? 'shadow_timeout' : 'shadow_error',
            primaryCandidateCount: primaryResult.length,
            primaryLatencyMs,
            primaryProvider: 'pgroonga',
            shadowLatencyMs: elapsed(runtime, shadowStartedAt),
            shadowProvider: 'portable',
          }),
        );
      }
      return primaryResult;
    },
  };
}

function createPortablePrimaryRepository(
  options: KeywordTransitionRepositoryOptions,
): KeywordCandidateRepository {
  const runtime = createRuntime(options);
  return {
    async search(input) {
      const primaryStartedAt = runtime.now();
      try {
        const primaryResult = await withTimeout(() => options.portable.search(input), runtime);
        notify(
          runtime,
          buildObservation(options.mode, {
            outcome: 'success',
            primaryCandidateCount: primaryResult.length,
            primaryLatencyMs: elapsed(runtime, primaryStartedAt),
            primaryProvider: 'portable',
          }),
        );
        return primaryResult;
      } catch (error) {
        if (error instanceof KeywordQueryRejectedError) {
          notify(
            runtime,
            buildObservation(options.mode, {
              mismatchCategories: [],
              outcome: 'rejected',
              primaryLatencyMs: elapsed(runtime, primaryStartedAt),
              primaryProvider: 'portable',
              reason: 'query_rejected',
            }),
          );
          throw error;
        }
        const fallbackStartedAt = runtime.now();
        try {
          const fallbackResult = await withTimeout(() => options.pgroonga.search(input), runtime);
          notify(
            runtime,
            buildObservation(options.mode, {
              fallbackCandidateCount: fallbackResult.length,
              fallbackLatencyMs: elapsed(runtime, fallbackStartedAt),
              fallbackProvider: 'pgroonga',
              outcome: 'fallback_success',
              primaryLatencyMs: elapsed(runtime, primaryStartedAt),
              primaryProvider: 'portable',
              reason: 'primary_error',
            }),
          );
          return fallbackResult;
        } catch {
          notify(
            runtime,
            buildObservation(options.mode, {
              fallbackLatencyMs: elapsed(runtime, fallbackStartedAt),
              fallbackProvider: 'pgroonga',
              outcome: 'unavailable',
              primaryLatencyMs: elapsed(runtime, primaryStartedAt),
              primaryProvider: 'portable',
              reason: 'fallback_error',
            }),
          );
          throw new KeywordCandidateUnavailableError();
        }
      }
    },
  };
}

interface ObservationOverrides {
  readonly fallbackCandidateCount?: number;
  readonly fallbackLatencyMs?: number;
  readonly fallbackProvider?: KeywordTransitionProvider | 'none';
  readonly mismatchCategories?: readonly KeywordTransitionMismatchCategory[];
  readonly outcome: KeywordTransitionOutcome;
  readonly primaryCandidateCount?: number;
  readonly primaryLatencyMs: number;
  readonly primaryProvider: KeywordTransitionProvider;
  readonly reason?: KeywordTransitionObservation['reason'];
  readonly shadowCandidateCount?: number;
  readonly shadowLatencyMs?: number;
  readonly shadowProvider?: KeywordTransitionProvider | 'none';
}

function buildObservation(
  mode: KeywordTransitionMode,
  overrides: ObservationOverrides,
): KeywordTransitionObservation {
  return {
    capability: 'keyword',
    event: 'keyword_transition_observation',
    ...(overrides.fallbackCandidateCount === undefined
      ? {}
      : { fallbackCandidateCount: overrides.fallbackCandidateCount }),
    fallbackLatencyMs: overrides.fallbackLatencyMs ?? 0,
    fallbackProvider: overrides.fallbackProvider ?? 'none',
    mismatchCategories: [...new Set(overrides.mismatchCategories ?? [])].sort(),
    mode,
    operation: 'search',
    outcome: overrides.outcome,
    ...(overrides.primaryCandidateCount === undefined
      ? {}
      : { primaryCandidateCount: overrides.primaryCandidateCount }),
    primaryLatencyMs: overrides.primaryLatencyMs,
    primaryProvider: overrides.primaryProvider,
    reason: overrides.reason ?? 'none',
    ...(overrides.shadowCandidateCount === undefined
      ? {}
      : { shadowCandidateCount: overrides.shadowCandidateCount }),
    shadowLatencyMs: overrides.shadowLatencyMs ?? 0,
    shadowProvider: overrides.shadowProvider ?? 'none',
  };
}

interface Runtime extends KeywordTransitionRuntimeOptions {
  readonly cancelTimeout: (handle: unknown) => void;
  readonly now: () => number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
}

function createRuntime(options: KeywordTransitionRuntimeOptions): Runtime {
  return {
    cancelTimeout:
      options.cancelTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    now: options.now ?? Date.now,
    observer: options.observer,
    scheduleTimeout:
      options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
  };
}

function notify(runtime: Runtime, observation: KeywordTransitionObservation): void {
  if (!runtime.observer) return;
  try {
    void Promise.resolve(runtime.observer(observation)).catch(() => undefined);
  } catch {
    // Observability must never change keyword results or fallback behavior.
  }
}

function compareCandidates(
  primary: readonly RankedChunkCandidate[],
  shadow: readonly RankedChunkCandidate[],
): KeywordTransitionMismatchCategory[] {
  const categories: KeywordTransitionMismatchCategory[] = [];
  if (primary.length !== shadow.length) categories.push('candidate_count');

  const primaryKeys = primary.map(candidateKey).sort();
  const shadowKeys = shadow.map(candidateKey).sort();
  if (!sameStrings(primaryKeys, shadowKeys)) categories.push('candidate_set');

  const primaryRanks = new Map(
    primary.map((candidate) => [candidateKey(candidate), candidate.rank]),
  );
  const shadowRanks = new Map(shadow.map((candidate) => [candidateKey(candidate), candidate.rank]));
  if (
    primaryRanks.size !== shadowRanks.size ||
    [...primaryRanks].some(([key, rank]) => shadowRanks.get(key) !== rank)
  ) {
    categories.push('rank');
  }

  const primaryProvenance = new Map(
    primary.map((candidate) => [candidateKey(candidate), provenanceKey(candidate)]),
  );
  const shadowProvenance = new Map(
    shadow.map((candidate) => [candidateKey(candidate), provenanceKey(candidate)]),
  );
  if (
    primaryProvenance.size !== shadowProvenance.size ||
    [...primaryProvenance].some(([key, provenance]) => shadowProvenance.get(key) !== provenance)
  ) {
    categories.push('snippet_provenance');
  }
  return categories;
}

function candidateKey(candidate: RankedChunkCandidate): string {
  return `${candidate.documentId}\u0000${candidate.chunkId}`;
}

function provenanceKey(candidate: RankedChunkCandidate): string {
  return [
    candidate.canonicalUri,
    candidate.chunkIndex,
    candidate.docType,
    candidate.rawDocumentId,
    candidate.snippet ?? '',
    candidate.title,
  ].join('\u0000');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

class KeywordTransitionTimeoutError extends Error {}

async function withTimeout<T>(operation: () => Promise<T>, runtime: Runtime): Promise<T> {
  const pending = Promise.resolve().then(operation);
  let handle: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = runtime.scheduleTimeout(
      () => reject(new KeywordTransitionTimeoutError()),
      KEYWORD_TRANSITION_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    runtime.cancelTimeout(handle);
  }
}

function elapsed(runtime: Runtime, startedAt: number): number {
  return Math.max(0, Math.round(runtime.now() - startedAt));
}
