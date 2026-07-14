import { NextResponse } from 'next/server';
import { createPostgresGraphViewerRepository } from '../../../../../../src/graph-viewer';
import {
  type PublicGraphRequestBodyParseResult,
  parsePublicGraphRequestBody,
  runPublicGraphApi,
} from '../../../../../../src/public-graph-api';

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
  let parsedBody: PublicGraphRequestBodyParseResult;
  try {
    parsedBody = parsePublicGraphRequestBody(await request.json());
  } catch {
    return publicGraphErrorResponse('invalid_json', 'Invalid JSON body.', 400);
  }
  if (!parsedBody.ok) {
    return publicGraphErrorResponse(
      parsedBody.error.code,
      parsedBody.error.message,
      parsedBody.status,
    );
  }
  if (!parsedBody.queryId) {
    return publicGraphErrorResponse('invalid_request', 'queryId is required.', 400);
  }

  try {
    const result = await runPublicGraphApi(
      {
        limit: parsedBody.limit,
        periodEnd: parsedBody.periodEnd,
        periodStart: parsedBody.periodStart,
        projectSlug,
        queryId: parsedBody.queryId,
      },
      { repository: createPostgresGraphViewerRepository() },
    );
    if (result.status === 200) {
      return NextResponse.json(result.body);
    }
    return publicGraphErrorResponse(result.error.code, result.error.message, result.status);
  } catch (error) {
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
