import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  businessHoursFromEnv,
  chatNowFromEnv,
  createExtractiveChatProvider,
  createGeminiChatProvider,
  createMemoryRateLimiter,
  createPostgresChatRepository,
  ProjectAccessDeniedError,
  runPrivateChat,
} from '../../../../../src/chat';

const rateLimiter = createMemoryRateLimiter({ limit: 20, windowMs: 60_000 });

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

  try {
    const userId = await requireSessionUserId();
    const provider =
      process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL
        ? createGeminiChatProvider({
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.GEMINI_CHAT_MODEL,
          })
        : createExtractiveChatProvider();
    const response = await runPrivateChat(
      { now: chatNowFromEnv(process.env), projectSlug, question, userId },
      {
        businessHours: businessHoursFromEnv(process.env),
        provider,
        rateLimiter,
        repository: createPostgresChatRepository(getRequiredAdminSql()),
      },
    );
    const status =
      response.status === 'db_outside_business_hours'
        ? 503
        : response.status === 'rate_limited'
          ? 429
          : 200;
    return NextResponse.json(response, { status });
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
