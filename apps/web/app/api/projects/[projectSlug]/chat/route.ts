import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  createMemoryRateLimiter,
  createPostgresChatRepository,
  isOutsideBusinessHoursFromEnv,
  ProjectAccessDeniedError,
  privateChatHistoryToMastraMessages,
  privateChatUnavailableResponse,
} from '../../../../../src/chat';
import {
  createMastraProjectChatBody,
  mastraFetchHeaders,
  mastraGenerateToChatResponse,
  mastraProjectChatGenerateUrl,
} from '../../../../../src/mastra-chat';
import { parsePositiveEnvInt } from '../../../../../src/request-client';

const rateLimiter = createMemoryRateLimiter({ limit: 20, windowMs: 60_000 });
const privateChatQuestionMaxLength = parsePositiveEnvInt(
  process.env.PUFU_LENS_PRIVATE_CHAT_QUESTION_MAX_LENGTH,
  2000,
);

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  let question = '';
  try {
    const body = (await request.json()) as { question?: unknown };
    question = typeof body.question === 'string' ? body.question.trim() : '';
  } catch {
    return chatErrorResponse('invalid_json', 'Invalid JSON body', 400);
  }
  if (!question) {
    return chatErrorResponse('invalid_request', 'question is required', 400);
  }
  if (question.length > privateChatQuestionMaxLength) {
    return chatErrorResponse(
      'private_chat_question_too_long',
      `question must be ${privateChatQuestionMaxLength} characters or less`,
      413,
    );
  }

  try {
    const userId = await requireSessionUserId();
    if (isOutsideBusinessHoursFromEnv(process.env)) {
      return NextResponse.json(privateChatUnavailableResponse(projectSlug), { status: 503 });
    }
    if (!rateLimiter.check({ projectSlug, userId })) {
      return NextResponse.json(
        {
          answer: 'rate limit exceeded',
          projectSlug,
          sources: [],
          status: 'rate_limited',
          toolCalls: [],
        },
        { status: 429 },
      );
    }
    const repository = createPostgresChatRepository(getRequiredAdminSql());
    const project = await repository.lookupProjectMember({ projectSlug, userId });
    if (!project) {
      throw new ProjectAccessDeniedError(projectSlug);
    }
    const history = await repository.listPrivateChatHistoryForContext({
      projectId: project.id,
      userId,
    });
    const mastraUrl = mastraProjectChatGenerateUrl();
    const mastraResponse = await fetch(mastraUrl, {
      body: JSON.stringify(
        createMastraProjectChatBody({
          graphName: project.graphName,
          history: privateChatHistoryToMastraMessages(history),
          projectId: project.id,
          question,
        }),
      ),
      headers: await mastraFetchHeaders({ url: mastraUrl }),
      method: 'POST',
      signal: request.signal,
    });
    if (!mastraResponse.ok) {
      const errorText = await mastraResponse.text().catch(() => '');
      throw new Error(
        `Mastra project chat agent failed: HTTP ${mastraResponse.status} - ${errorText}`,
      );
    }
    const mastraBody = (await mastraResponse.json()) as unknown;
    const chatResponse = mastraGenerateToChatResponse({
      mastraResponse: mastraBody,
      projectSlug,
      question,
    });
    if (chatResponse.status === 'answered') {
      try {
        await repository.savePrivateChatTurn({
          answer: chatResponse.answer,
          editing: chatResponse.editing,
          projectId: project.id,
          question,
          sources: chatResponse.sources,
          toolCalls: chatResponse.toolCalls,
          userId,
        });
      } catch (saveError) {
        console.error('Failed to persist private chat turn:', saveError);
      }
    }
    return NextResponse.json(chatResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthRequiredError) {
      return chatErrorResponse('auth_required', message, 401);
    }
    if (error instanceof ProjectAccessDeniedError) {
      return chatErrorResponse('project_access_denied', message, 403);
    }
    return chatErrorResponse('chat_internal_error', message, 500);
  }
}

function chatErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
