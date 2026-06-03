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
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  const userId = process.env.PUFU_LENS_CHAT_USER_ID ?? process.env.PUFU_LENS_ADMIN_USER_ID;
  if (!userId) {
    return NextResponse.json({ error: 'PUFU_LENS_CHAT_USER_ID is required' }, { status: 503 });
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
      { projectSlug, question, userId },
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
