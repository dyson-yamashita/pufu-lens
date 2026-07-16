import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../src/auth-session';
import {
  createPostgresChatRepository,
  type PrivateChatHistoryListResponse,
  ProjectAccessDeniedError,
} from '../../../../../../src/chat';

/**
 * Retrieves private chat history items for an authenticated user within a project.
 *
 * @param params - Route parameters containing the project slug
 * @returns A JSON response containing the chat history items or a structured error
 */
export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;

  try {
    const userId = await requireSessionUserId();
    const repository = createPostgresChatRepository(getRequiredAdminSql());
    const project = await repository.lookupProjectMember({ projectSlug, userId });
    if (!project) {
      throw new ProjectAccessDeniedError(projectSlug);
    }
    const items = await repository.listPrivateChatHistoryForUi({
      projectId: project.id,
      userId,
    });
    return NextResponse.json({ items } satisfies PrivateChatHistoryListResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthRequiredError) {
      return chatHistoryErrorResponse('auth_required', message, 401);
    }
    if (error instanceof ProjectAccessDeniedError) {
      return chatHistoryErrorResponse('project_access_denied', message, 403);
    }
    console.error('Private chat history API error:', error);
    return chatHistoryErrorResponse(
      'chat_history_internal_error',
      'Failed to load private chat history.',
      500,
    );
  }
}

function chatHistoryErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
