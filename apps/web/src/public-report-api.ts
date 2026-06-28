import { type NextRequest, NextResponse } from 'next/server';
import { getVisiblePublicProject } from './admin-db';
import { getRequiredAdminSql } from './admin-sql';
import {
  businessHoursFromEnv,
  chatNowFromEnv,
  createPublicChatMemoryRateLimiter,
  isWithinBusinessHours,
} from './chat';
import {
  createMastraProjectChatBody,
  mastraFetchHeaders,
  mastraGenerateToChatResponse,
  mastraProjectChatGenerateUrl,
} from './mastra-chat';
import {
  assertPublicReportAccess,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  getPublicReport,
  isSafePublicReportLocator,
  PublicReportNotFoundError,
  reportNowFromEnv,
} from './report';
import { parsePositiveEnvInt, trustedClientIp } from './request-client';

const hourlyRateLimiter = createPublicChatMemoryRateLimiter({
  limit: parsePositiveEnvInt(process.env.PUFU_LENS_PUBLIC_CHAT_HOURLY_LIMIT, 10),
  windowMs: 60 * 60_000,
});
const dailyRateLimiter = createPublicChatMemoryRateLimiter({
  limit: parsePositiveEnvInt(process.env.PUFU_LENS_PUBLIC_CHAT_DAILY_LIMIT, 50),
  windowMs: 24 * 60 * 60_000,
});
const publicChatQuestionMaxLength = parsePositiveEnvInt(
  process.env.PUFU_LENS_PUBLIC_CHAT_QUESTION_MAX_LENGTH,
  2000,
);

export async function handlePublicReportGet(input: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  if (!isSafePublicReportLocator(input)) {
    return publicReportNotFound();
  }

  try {
    const businessHours = businessHoursFromEnv(process.env);
    const now = reportNowFromEnv(process.env) ?? new Date();
    if (!isWithinBusinessHours(now, businessHours)) {
      return NextResponse.json(
        { report: null, status: 'db_outside_business_hours' },
        { status: 503 },
      );
    }
    const response = await getPublicReport({
      options: {
        businessHours,
        now,
        repository: createPostgresReportRepository(getRequiredAdminSql()),
        storage: createReportStorageFromEnv(),
      },
      projectSlug: input.projectSlug,
      reportId: input.reportId,
    });
    return NextResponse.json(response, {
      status: response.status === 'db_outside_business_hours' ? 503 : 200,
    });
  } catch (error) {
    if (error instanceof PublicReportNotFoundError) {
      return publicReportNotFound();
    }
    console.error('Public Report API Error:', error);
    return NextResponse.json(
      { error: { code: 'public_report_internal_error', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }
}

export async function handlePublicChatPost(
  request: NextRequest,
  input: {
    readonly projectSlug: string;
    readonly reportId: string;
  },
) {
  if (!isSafePublicReportLocator(input)) {
    return publicChatNotFound();
  }

  let question = '';
  try {
    const body = (await request.json()) as Record<string, unknown> | null;
    question =
      body && typeof body === 'object' && typeof body.question === 'string'
        ? body.question.trim()
        : '';
  } catch {
    return publicChatErrorResponse('invalid_json', 'Invalid JSON body', 400);
  }
  if (!question) {
    return publicChatErrorResponse('invalid_request', 'question is required', 400);
  }
  if (question.length > publicChatQuestionMaxLength) {
    return publicChatErrorResponse(
      'public_chat_question_too_long',
      `question must be ${publicChatQuestionMaxLength} characters or less`,
      413,
    );
  }

  try {
    const businessHours = businessHoursFromEnv(process.env);
    if (!isWithinBusinessHours(chatNowFromEnv(process.env) ?? new Date(), businessHours)) {
      return NextResponse.json(
        {
          answer: 'db_outside_business_hours',
          projectSlug: input.projectSlug,
          sources: [],
          status: 'db_outside_business_hours',
          toolCalls: [],
        },
        { status: 503 },
      );
    }
    const repository = createPostgresReportRepository(getRequiredAdminSql());
    const { project } = await assertPublicReportAccess({
      projectSlug: input.projectSlug,
      reportId: input.reportId,
      repository,
    });
    for (const rateLimiter of [hourlyRateLimiter, dailyRateLimiter]) {
      if (
        !rateLimiter.check({ clientIp: trustedClientIp(request.headers), reportId: input.reportId })
      ) {
        return NextResponse.json(
          {
            answer: 'rate limit exceeded',
            projectSlug: input.projectSlug,
            sources: [],
            status: 'rate_limited',
            toolCalls: [],
          },
          { status: 429 },
        );
      }
    }
    const mastraUrl = mastraProjectChatGenerateUrl();
    const mastraResponse = await fetch(mastraUrl, {
      body: JSON.stringify(
        createMastraProjectChatBody({
          projectId: project.id,
          question,
        }),
      ),
      headers: await mastraFetchHeaders({ url: mastraUrl }),
      method: 'POST',
      signal: request.signal,
    });
    if (!mastraResponse.ok) {
      throw new Error(`Mastra project chat agent failed: HTTP ${mastraResponse.status}`);
    }
    const mastraBody = (await mastraResponse.json()) as unknown;
    return NextResponse.json(
      mastraGenerateToChatResponse({
        mastraResponse: mastraBody,
        projectSlug: input.projectSlug,
        question,
      }),
    );
  } catch (error) {
    if (error instanceof PublicReportNotFoundError) {
      return publicChatNotFound();
    }
    console.error('Public Chat API Error:', error);
    return publicChatErrorResponse(
      'public_chat_internal_error',
      'An unexpected error occurred',
      500,
    );
  }
}

export async function handlePublicProjectChatPost(
  request: NextRequest,
  input: {
    readonly projectSlug: string;
  },
) {
  const publicProject = await getVisiblePublicProject(input.projectSlug);
  if (!publicProject) {
    return publicChatErrorResponse('public_project_not_found', 'Public project not found', 404);
  }
  const latestReport = publicProject.reports[0];
  if (!latestReport) {
    return NextResponse.json({
      answer: '公開 chat で利用できる report context はまだありません。',
      projectSlug: input.projectSlug,
      reportId: '',
      sources: [],
      status: 'no_public_report',
      toolCalls: [],
    });
  }
  return handlePublicChatPost(request, {
    projectSlug: input.projectSlug,
    reportId: latestReport.id,
  });
}

function publicReportNotFound() {
  return NextResponse.json(
    { error: { code: 'public_report_not_found', message: 'Public report not found' } },
    { status: 404 },
  );
}

function publicChatNotFound() {
  return publicChatErrorResponse('public_report_not_found', 'Public report not found', 404);
}

function publicChatErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
