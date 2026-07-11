import { NextResponse } from 'next/server';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../src/auth-session';
import { runGraphDocumentChunksApi } from '../../../../../../src/graph-document-chunks-api';
import { createPostgresGraphViewerRepository } from '../../../../../../src/graph-viewer';

/**
 * Loads document chunks for a graph document node in the requested project.
 *
 * @param request - The incoming request containing the documentId query parameter
 * @param params - The route parameters containing `projectSlug` (async in Next.js App Router)
 * @returns A JSON response with the document chunks or an error code
 */
export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  const documentId = new URL(request.url).searchParams.get('documentId');
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
    const result = await runGraphDocumentChunksApi(
      { documentId, projectSlug, userId },
      { repository: createPostgresGraphViewerRepository() },
    );
    if (result.status === 200) {
      return NextResponse.json({ chunks: result.chunks });
    }
    return graphDocumentChunksErrorResponse(result.error.code, result.error.message, result.status);
  } catch (error) {
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
