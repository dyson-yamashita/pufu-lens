import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import {
  businessHoursFromEnv,
  createExtractiveChatProvider,
  createGeminiChatProvider,
  createMemoryRateLimiter,
  createPostgresChatRepository,
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

  const userId = process.env.PUFU_LENS_CHAT_USER_ID ?? process.env.PUFU_LENS_ADMIN_USER_ID;
  if (!userId) {
    return chatErrorResponse('chat_user_not_configured', 'PUFU_LENS_CHAT_USER_ID is required', 503);
  }

  try {
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
    if (message.startsWith('Project access denied:')) {
      return chatErrorResponse('project_access_denied', message, 403);
    }
    return chatErrorResponse('chat_internal_error', message, 500);
  }
}

function chatErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function chatNowFromEnv(env: NodeJS.ProcessEnv): Date | undefined {
  if (!env.PUFU_LENS_CHAT_NOW) {
    return undefined;
  }
  const date = new Date(env.PUFU_LENS_CHAT_NOW);
  if (Number.isNaN(date.getTime())) {
    throw new Error('PUFU_LENS_CHAT_NOW must be an ISO 8601 datetime.');
  }
  return date;
}
