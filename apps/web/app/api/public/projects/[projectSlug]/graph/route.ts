import { NextResponse } from 'next/server';
import {
  createPostgresGraphViewerRepository,
  GraphAccessDeniedError,
  GraphLimitError,
  GraphPresetNotFoundError,
  normalizeGraphLimit,
  runPublicGraphPresetQuery,
} from '../../../../../../src/graph-viewer';

/**
 * Runs a graph preset query for a public project.
 *
 * @param request - The incoming request containing the query body.
 * @param params - The route parameters containing `projectSlug`.
 * @returns A JSON response with the query result or an error code.
 */
export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  let limit: number | undefined;
  let queryId = '';
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return publicGraphErrorResponse('invalid_json', 'Invalid JSON body.', 400);
    }
    const typedBody = body as { limit?: unknown; queryId?: unknown };
    queryId = typeof typedBody.queryId === 'string' ? typedBody.queryId.trim() : '';
    if ('limit' in typedBody) {
      limit = normalizeGraphLimit(typedBody.limit);
    }
    if ('cypher' in typedBody) {
      return publicGraphErrorResponse(
        'cypher_not_allowed',
        'Cypher body field is not allowed.',
        400,
      );
    }
  } catch (error) {
    if (error instanceof GraphLimitError) {
      return publicGraphErrorResponse('invalid_limit', error.message, 400);
    }
    return publicGraphErrorResponse('invalid_json', 'Invalid JSON body.', 400);
  }
  if (!queryId) {
    return publicGraphErrorResponse('invalid_request', 'queryId is required.', 400);
  }

  try {
    const response = await runPublicGraphPresetQuery(
      { limit, projectSlug, queryId },
      { repository: createPostgresGraphViewerRepository() },
    );
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof GraphAccessDeniedError) {
      return publicGraphErrorResponse('public_project_not_found', error.message, 404);
    }
    if (error instanceof GraphPresetNotFoundError) {
      return publicGraphErrorResponse('unknown_query_id', error.message, 400);
    }
    if (error instanceof GraphLimitError) {
      return publicGraphErrorResponse('invalid_limit', error.message, 400);
    }
    console.error('Public Graph API Error:', error);
    return publicGraphErrorResponse(
      'public_graph_internal_error',
      'An unexpected error occurred.',
      500,
    );
  }
}

function publicGraphErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
