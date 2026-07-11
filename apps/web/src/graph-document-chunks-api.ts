import {
  fetchGraphDocumentChunks,
  GraphAccessDeniedError,
  GraphInvalidDocumentIdError,
  type GraphViewerDocumentChunk,
  type GraphViewerRepository,
} from './graph-viewer.ts';

export type GraphDocumentChunksApiResult =
  | { readonly chunks: readonly GraphViewerDocumentChunk[]; readonly status: 200 }
  | {
      readonly error: { readonly code: string; readonly message: string };
      readonly status: 400 | 403;
    };

/**
 * Loads document chunks for a graph document node and maps domain errors to API responses.
 *
 * @param input - The project, document ID, and requesting user
 * @param options - Repository used to resolve project access and fetch document chunks
 * @returns A success payload with chunks or an error payload with an HTTP status
 */
export async function runGraphDocumentChunksApi(
  input: { documentId: string | null; projectSlug: string; userId: string },
  options: { repository: GraphViewerRepository },
): Promise<GraphDocumentChunksApiResult> {
  try {
    const chunks = await fetchGraphDocumentChunks(
      { documentId: input.documentId ?? '', projectSlug: input.projectSlug, userId: input.userId },
      options,
    );
    return { chunks, status: 200 };
  } catch (error) {
    if (error instanceof GraphAccessDeniedError) {
      return {
        error: { code: 'project_access_denied', message: error.message },
        status: 403,
      };
    }
    if (error instanceof GraphInvalidDocumentIdError) {
      return {
        error: { code: 'invalid_document_id', message: error.message },
        status: 400,
      };
    }
    throw error;
  }
}
