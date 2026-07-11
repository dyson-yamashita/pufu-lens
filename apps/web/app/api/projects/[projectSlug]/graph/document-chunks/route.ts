import { NextResponse } from 'next/server';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../src/auth-session';
import {
  createPostgresGraphViewerRepository,
  fetchGraphDocumentChunks,
  GraphAccessDeniedError,
  GraphInvalidDocumentIdError,
} from '../../../../../../src/graph-viewer';

/**
 * Loads document chunks for a graph document node in the requested project.
 *
 * @param request - The incoming request containing the documentId query parameter
 * @param params - The route parameters containing `projectSlug`
 * @returns A JSON response with the document chunks or an error code
 */
export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  const documentId = new URL(request.url).searchParams.get('documentId')?.trim() ?? '';
  let userId: string;
  try {
    userId = await requireSessionUserId();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return graphDocumentChunksErrorResponse('auth_required', error.message, 401);
    }
    throw error;
  }

  try {
    const chunks = await fetchGraphDocumentChunks(
      { documentId, projectSlug, userId },
      { repository: createPostgresGraphViewerRepository() },
    );
    return NextResponse.json({ chunks });
  } catch (error) {
    if (error instanceof GraphAccessDeniedError) {
      return graphDocumentChunksErrorResponse('project_access_denied', error.message, 403);
    }
    if (error instanceof GraphInvalidDocumentIdError) {
      return graphDocumentChunksErrorResponse('invalid_document_id', error.message, 400);
    }
    console.error('Graph document chunks API error:', error);
    return graphDocumentChunksErrorResponse(
      'graph_document_chunks_internal_error',
      'An unexpected error occurred.',
      500,
    );
  }
}

function graphDocumentChunksErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
