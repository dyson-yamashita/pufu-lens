import { NextResponse } from 'next/server';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  createPostgresGraphViewerRepository,
  GraphAccessDeniedError,
  GraphLimitError,
  GraphPeriodError,
  GraphPresetNotFoundError,
  normalizeGraphLimit,
  normalizeGraphPeriodFilter,
  runGraphPresetQuery,
} from '../../../../../src/graph-viewer';

/**
 * Runs a graph preset query for the requested project.
 *
 * @param request - The incoming request containing the query body
 * @param params - The route parameters containing `projectSlug`
 * @returns A JSON response with the query result or an error code
 */
export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  let limit: number | undefined;
  let periodEnd: unknown;
  let periodStart: unknown;
  let queryId = '';
  let userId: string;
  try {
    userId = await requireSessionUserId();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return graphErrorResponse('auth_required', error.message, 401);
    }
    throw error;
  }
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return graphErrorResponse('invalid_json', 'Invalid JSON body.', 400);
    }
    const typedBody = body as {
      limit?: unknown;
      periodEnd?: unknown;
      periodStart?: unknown;
      queryId?: unknown;
    };
    queryId = typeof typedBody.queryId === 'string' ? typedBody.queryId.trim() : '';
    if ('limit' in typedBody) {
      limit = normalizeGraphLimit(typedBody.limit);
    }
    if ('periodStart' in typedBody) {
      periodStart = typedBody.periodStart;
    }
    if ('periodEnd' in typedBody) {
      periodEnd = typedBody.periodEnd;
    }
    normalizeGraphPeriodFilter({ periodEnd, periodStart });
    if ('cypher' in typedBody) {
      return graphErrorResponse('cypher_not_allowed', 'Cypher body field is not allowed.', 400);
    }
  } catch (error) {
    if (error instanceof GraphLimitError) {
      return graphErrorResponse('invalid_limit', error.message, 400);
    }
    if (error instanceof GraphPeriodError) {
      return graphErrorResponse('invalid_period', error.message, 400);
    }
    return graphErrorResponse('invalid_json', 'Invalid JSON body.', 400);
  }
  if (!queryId) {
    return graphErrorResponse('invalid_request', 'queryId is required.', 400);
  }

  try {
    const response = await runGraphPresetQuery(
      { limit, periodEnd, periodStart, projectSlug, queryId, userId },
      { repository: createPostgresGraphViewerRepository() },
    );
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return graphErrorResponse('auth_required', error.message, 401);
    }
    if (error instanceof GraphAccessDeniedError) {
      return graphErrorResponse('project_access_denied', error.message, 403);
    }
    if (error instanceof GraphPresetNotFoundError) {
      return graphErrorResponse('unknown_query_id', error.message, 400);
    }
    if (error instanceof GraphLimitError) {
      return graphErrorResponse('invalid_limit', error.message, 400);
    }
    if (error instanceof GraphPeriodError) {
      return graphErrorResponse('invalid_period', error.message, 400);
    }
    console.error('Graph API Error:', error);
    return graphErrorResponse('graph_internal_error', 'An unexpected error occurred.', 500);
  }
}

function graphErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
