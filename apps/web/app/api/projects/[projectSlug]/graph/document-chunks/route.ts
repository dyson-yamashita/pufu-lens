import { NextResponse } from 'next/server';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../src/auth-session';
import {
  createPostgresGraphViewerRepository,
  fetchGraphDocumentChunks,
  GraphAccessDeniedError,
} from '../../../../../../src/graph-viewer';

/**
 * Fetches chunks for one selected graph Document node.
 *
 * @param request - The incoming request containing a `documentId` query parameter.
 * @param params - The route parameters containing `projectSlug`.
 * @returns A JSON response with chunks or an error code.
 */
export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  let userId: string;
  try {
    userId = await requireSessionUserId();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return graphDocumentChunksErrorResponse('auth_required', error.message, 401);
    }
    throw error;
  }

  const documentId = new URL(request.url).searchParams.get('documentId')?.trim() ?? '';
  if (!documentId) {
    return graphDocumentChunksErrorResponse('invalid_request', 'documentId is required.', 400);
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
    console.error('Graph Document Chunks API Error:', error);
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
