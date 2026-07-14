import {
  GraphAccessDeniedError,
  GraphLimitError,
  GraphPresetNotFoundError,
  type GraphQueryResult,
  type GraphViewerRepository,
  runPublicGraphPresetQuery,
} from './graph-viewer.ts';

export type PublicGraphRequestBodyParseResult =
  | { readonly limit?: unknown; readonly ok: true; readonly queryId: string }
  | {
      readonly error: { readonly code: string; readonly message: string };
      readonly ok: false;
      readonly status: 400;
    };

export type PublicGraphApiResult =
  | { readonly body: GraphQueryResult; readonly status: 200 }
  | {
      readonly error: { readonly code: string; readonly message: string };
      readonly status: 400 | 404 | 500;
    };

/**
 * Parses a public graph API request body.
 *
 * @param body - The raw JSON request body
 * @returns Parsed query parameters or a client error payload
 */
export function parsePublicGraphRequestBody(body: unknown): PublicGraphRequestBodyParseResult {
  if (!isRecord(body)) {
    return {
      error: { code: 'invalid_json', message: 'Invalid JSON body.' },
      ok: false,
      status: 400,
    };
  }
  if ('cypher' in body) {
    return {
      error: { code: 'cypher_not_allowed', message: 'Cypher body field is not allowed.' },
      ok: false,
      status: 400,
    };
  }
  const queryId = typeof body.queryId === 'string' ? body.queryId.trim() : '';
  const limit = 'limit' in body ? body.limit : undefined;
  return { limit, ok: true, queryId };
}

/**
 * Runs a public graph preset query and maps domain errors to API responses.
 *
 * @param input - The project slug, preset ID, and optional limit
 * @param options - Repository used to resolve public project access and execute the preset
 * @returns A success payload with graph data or an error payload with an HTTP status
 */
export async function runPublicGraphApi(
  input: { limit?: unknown; projectSlug: string; queryId: string },
  options: { repository: GraphViewerRepository },
): Promise<PublicGraphApiResult> {
  try {
    const body = await runPublicGraphPresetQuery(input, options);
    return { body, status: 200 };
  } catch (error) {
    if (error instanceof GraphAccessDeniedError) {
      return {
        error: { code: 'public_project_not_found', message: error.message },
        status: 404,
      };
    }
    if (error instanceof GraphPresetNotFoundError) {
      return {
        error: { code: 'unknown_query_id', message: error.message },
        status: 400,
      };
    }
    if (error instanceof GraphLimitError) {
      return {
        error: { code: 'invalid_limit', message: error.message },
        status: 400,
      };
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
