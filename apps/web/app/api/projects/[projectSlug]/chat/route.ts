import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  type ChatResponse,
  createMemoryRateLimiter,
  createPostgresChatRepository,
  ProjectAccessDeniedError,
  parsePrivateChatRequestBody,
  privateChatHistoryToMastraMessages,
} from '../../../../../src/chat';
import {
  clientAcceptsPrivateChatStream,
  createPrivateChatSearchProgressEvent,
  encodePrivateChatStreamEvent,
} from '../../../../../src/private-chat-stream';
import {
  isPrivateChatWorkflowAbortError,
  logPrivateChatWorkflowFailure,
  PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE,
  runPrivateChatSearchViaMastraWorkflow,
} from '../../../../../src/private-chat-workflow-client';
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
  let includeHistory: boolean;
  try {
    const parsedBody = parsePrivateChatRequestBody(await request.json());
    if (!parsedBody.ok) {
      return chatErrorResponse('invalid_request', parsedBody.error, 400);
    }
    question = parsedBody.question;
    includeHistory = parsedBody.includeHistory;
  } catch {
    return chatErrorResponse('invalid_json', 'Invalid JSON body', 400);
  }
  if (question.length > privateChatQuestionMaxLength) {
    return chatErrorResponse(
      'private_chat_question_too_long',
      `question must be ${privateChatQuestionMaxLength} characters or less`,
      413,
    );
  }

  const wantsStream = clientAcceptsPrivateChatStream(request);

  try {
    const userId = await requireSessionUserId();
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
    const history = includeHistory
      ? await repository.listPrivateChatHistoryForContext({
          projectId: project.id,
          userId,
        })
      : [];
    const mastraHistory = privateChatHistoryToMastraMessages(history);

    if (wantsStream) {
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const encoder = new TextEncoder();
          const writeProgress = (
            stage: Parameters<typeof createPrivateChatSearchProgressEvent>[0],
          ) => {
            controller.enqueue(
              encoder.encode(
                encodePrivateChatStreamEvent(createPrivateChatSearchProgressEvent(stage)),
              ),
            );
          };
          try {
            const chatResponse = await runPrivateChatSearchViaMastraWorkflow({
              graphName: project.graphName,
              history: mastraHistory,
              onStage: writeProgress,
              projectId: project.id,
              projectSlug,
              question,
              signal: request.signal,
            });
            await persistPrivateChatTurn({
              chatResponse,
              projectId: project.id,
              question,
              repository,
              userId,
            });
            controller.enqueue(
              encoder.encode(
                encodePrivateChatStreamEvent({
                  response: chatResponse,
                  type: 'result',
                }),
              ),
            );
            controller.close();
          } catch (error) {
            if (isPrivateChatWorkflowAbortError(error)) {
              return;
            }
            logPrivateChatWorkflowFailure(error);
            controller.enqueue(
              encoder.encode(
                encodePrivateChatStreamEvent({
                  code: mapPrivateChatStreamErrorCode(error),
                  message: PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE,
                  type: 'error',
                }),
              ),
            );
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'application/x-ndjson; charset=utf-8',
        },
      });
    }

    const chatResponse = await runPrivateChatSearchViaMastraWorkflow({
      graphName: project.graphName,
      history: mastraHistory,
      projectId: project.id,
      projectSlug,
      question,
      signal: request.signal,
    });
    await persistPrivateChatTurn({
      chatResponse,
      projectId: project.id,
      question,
      repository,
      userId,
    });
    return NextResponse.json(chatResponse);
  } catch (error) {
    logPrivateChatWorkflowFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthRequiredError) {
      return chatErrorResponse('auth_required', message, 401);
    }
    if (error instanceof ProjectAccessDeniedError) {
      return chatErrorResponse('project_access_denied', message, 403);
    }
    return chatErrorResponse('chat_internal_error', PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE, 500);
  }
}

async function persistPrivateChatTurn(input: {
  readonly chatResponse: ChatResponse;
  readonly projectId: string;
  readonly question: string;
  readonly repository: ReturnType<typeof createPostgresChatRepository>;
  readonly userId: string;
}): Promise<void> {
  if (input.chatResponse.status !== 'answered') {
    return;
  }
  try {
    await input.repository.savePrivateChatTurn({
      answer: input.chatResponse.answer,
      editing: input.chatResponse.editing,
      projectId: input.projectId,
      question: input.question,
      sources: input.chatResponse.sources,
      toolCalls: input.chatResponse.toolCalls,
      userId: input.userId,
    });
  } catch (saveError) {
    console.error('Failed to persist private chat turn:', saveError);
  }
}

function mapPrivateChatStreamErrorCode(error: unknown): string {
  if (error instanceof AuthRequiredError) {
    return 'auth_required';
  }
  if (error instanceof ProjectAccessDeniedError) {
    return 'project_access_denied';
  }
  return 'chat_internal_error';
}

function chatErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
