/** Default number of project documents supplied to hybrid-search answer synthesis. */
export const DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT = 5;

/** Smallest project-configurable hybrid-search document limit. */
export const MIN_HYBRID_SEARCH_DOCUMENT_LIMIT = 1;

/** Largest project-configurable hybrid-search document limit. */
export const MAX_HYBRID_SEARCH_DOCUMENT_LIMIT = 20;

export const HYBRID_SEARCH_DOCUMENT_LIMIT_SETTING_KEY = 'hybridSearchDocumentLimit';

/**
 * Parses a Project Settings JSON value and falls back to the documented hybrid-search default.
 *
 * @param settings - Untrusted `projects.settings` JSON read from PostgreSQL
 * @returns A bounded integer suitable for retrieval and synthesis limits
 */
export function hybridSearchDocumentLimitFromSettings(settings: unknown): number {
  if (!isRecord(settings)) {
    return DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT;
  }
  const value = settings[HYBRID_SEARCH_DOCUMENT_LIMIT_SETTING_KEY];
  return isHybridSearchDocumentLimit(value) ? value : DEFAULT_HYBRID_SEARCH_DOCUMENT_LIMIT;
}

/** Returns whether a value is a supported project hybrid-search document limit. */
export function isHybridSearchDocumentLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_HYBRID_SEARCH_DOCUMENT_LIMIT &&
    value <= MAX_HYBRID_SEARCH_DOCUMENT_LIMIT
  );
}

/**
 * Validates a submitted Project Settings value.
 *
 * @param value - Form value expected to contain a base-10 integer
 * @returns The validated hybrid-search document limit
 * @throws When the value is not an integer between the supported bounds
 */
export function requireHybridSearchDocumentLimit(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('hybridSearchDocumentLimit must be an integer.');
  }
  const parsed = Number(value);
  if (!isHybridSearchDocumentLimit(parsed)) {
    throw new Error(
      `hybridSearchDocumentLimit must be between ${MIN_HYBRID_SEARCH_DOCUMENT_LIMIT} and ${MAX_HYBRID_SEARCH_DOCUMENT_LIMIT}.`,
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
