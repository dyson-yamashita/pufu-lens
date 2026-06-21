import { NextResponse } from 'next/server';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  createPostgresGraphViewerRepository,
  GraphAccessDeniedError,
  GraphPresetNotFoundError,
  runGraphPresetQuery,
} from '../../../../../src/graph-viewer';

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  let queryId = '';
  let userId = '';
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
    const typedBody = body as { queryId?: unknown };
    queryId = typeof typedBody.queryId === 'string' ? typedBody.queryId.trim() : '';
    if ('cypher' in typedBody) {
      return graphErrorResponse('cypher_not_allowed', 'Cypher body field is not allowed.', 400);
    }
  } catch {
    return graphErrorResponse('invalid_json', 'Invalid JSON body.', 400);
  }
  if (!queryId) {
    return graphErrorResponse('invalid_request', 'queryId is required.', 400);
  }

  try {
    const response = await runGraphPresetQuery(
      { projectSlug, queryId, userId },
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
    console.error('Graph API Error:', error);
    return graphErrorResponse('graph_internal_error', 'An unexpected error occurred.', 500);
  }
}

function graphErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
