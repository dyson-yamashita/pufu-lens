import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  businessHoursFromEnv,
  chatNowFromEnv,
  createMemoryRateLimiter,
  createPostgresChatRepository,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
} from '../../../../../src/chat';
import {
  createMastraProjectChatBody,
  mastraGenerateToChatResponse,
  mastraProjectChatGenerateUrl,
} from '../../../../../src/mastra-chat';

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
    if (
      !isWithinBusinessHours(
        chatNowFromEnv(process.env) ?? new Date(),
        businessHoursFromEnv(process.env),
      )
    ) {
      return NextResponse.json(
        {
          answer: 'db_outside_business_hours',
          projectSlug,
          sources: [],
          status: 'db_outside_business_hours',
          toolCalls: [],
        },
        { status: 503 },
      );
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
    const mastraResponse = await fetch(mastraProjectChatGenerateUrl(), {
      body: JSON.stringify(createMastraProjectChatBody({ projectId: project.id, question })),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const mastraBody = (await mastraResponse.json()) as unknown;
    if (!mastraResponse.ok) {
      throw new Error(
        `Mastra project chat agent failed: HTTP ${mastraResponse.status} ${JSON.stringify(mastraBody)}`,
      );
    }
    return NextResponse.json(
      mastraGenerateToChatResponse({ mastraResponse: mastraBody, projectSlug }),
    );
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
