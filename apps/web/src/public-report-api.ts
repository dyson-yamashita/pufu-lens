import { type NextRequest, NextResponse } from 'next/server';
import { getVisiblePublicProject } from './admin-db';
import {
  createPublicChatMemoryRateLimiter,
  publicChatSources,
  shouldRefusePublicQuestion,
} from './chat';
import {
  createMastraPublicReportChatBody,
  mastraGenerateToPublicChatResponse,
  mastraPublicReportChatGenerateUrl,
} from './mastra-chat';
import {
  createReportStorageFromEnv,
  getPublicReport,
  getPublicReportArtifacts,
  isSafePublicReportLocator,
  PublicReportNotFoundError,
} from './report';
import { trustedClientIp } from './request-client';

const hourlyRateLimiter = createPublicChatMemoryRateLimiter({
  limit: parseEnvInt(process.env.PUFU_LENS_PUBLIC_CHAT_HOURLY_LIMIT, 10),
  windowMs: 60 * 60_000,
});
const dailyRateLimiter = createPublicChatMemoryRateLimiter({
  limit: parseEnvInt(process.env.PUFU_LENS_PUBLIC_CHAT_DAILY_LIMIT, 50),
  windowMs: 24 * 60 * 60_000,
});
const publicChatQuestionMaxLength = parseEnvInt(
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
    const response = await getPublicReport({
      projectSlug: input.projectSlug,
      reportId: input.reportId,
      storage: createReportStorageFromEnv(),
    });
    return NextResponse.json(response);
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
    const artifacts = await getPublicReportArtifacts({
      projectSlug: input.projectSlug,
      reportId: input.reportId,
      storage: createReportStorageFromEnv(),
    });
    for (const rateLimiter of [hourlyRateLimiter, dailyRateLimiter]) {
      if (
        !rateLimiter.check({ clientIp: trustedClientIp(request.headers), reportId: input.reportId })
      ) {
        return NextResponse.json(
          {
            answer: 'rate limit exceeded',
            projectSlug: input.projectSlug,
            reportId: input.reportId,
            sources: [],
            status: 'rate_limited',
            toolCalls: [],
          },
          { status: 429 },
        );
      }
    }
    const toolCalls = [
      { name: 'public-report-fetch', resultCount: 1 },
      { name: 'public-context-fetch', resultCount: artifacts.contextBundle.sections.length },
    ] as const;
    if (shouldRefusePublicQuestion(question)) {
      return NextResponse.json({
        answer:
          '公開レポートの範囲外、または未公開情報の要求には回答できません。公開済み section id / public source id に基づく質問をしてください。',
        projectSlug: input.projectSlug,
        reportId: input.reportId,
        sources: [],
        status: 'refused',
        toolCalls,
      });
    }
    const mastraResponse = await fetch(mastraPublicReportChatGenerateUrl(), {
      body: JSON.stringify(
        createMastraPublicReportChatBody({
          contextBundle: artifacts.contextBundle,
          projectSlug: input.projectSlug,
          question,
          report: artifacts.report,
          reportId: input.reportId,
        }),
      ),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: request.signal,
    });
    if (!mastraResponse.ok) {
      const errorText = await mastraResponse.text().catch(() => '');
      throw new Error(
        `Mastra public report chat agent failed: HTTP ${mastraResponse.status} - ${errorText}`,
      );
    }
    const mastraBody = (await mastraResponse.json()) as unknown;
    return NextResponse.json(
      withPublicFallbackSources(
        mastraGenerateToPublicChatResponse({
          mastraResponse: mastraBody,
          projectSlug: input.projectSlug,
          reportId: input.reportId,
        }),
        publicChatSources(artifacts.report, artifacts.contextBundle),
        toolCalls,
      ),
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

function withPublicFallbackSources(
  response: ReturnType<typeof mastraGenerateToPublicChatResponse>,
  sources: ReturnType<typeof publicChatSources>,
  toolCalls: readonly [
    { readonly name: 'public-report-fetch'; readonly resultCount: number },
    { readonly name: 'public-context-fetch'; readonly resultCount: number },
  ],
) {
  const toolCallNames = new Set(response.toolCalls.map((toolCall) => toolCall.name));
  return {
    ...response,
    sources: response.sources.length ? response.sources : sources,
    toolCalls: [
      ...response.toolCalls,
      ...toolCalls.filter((toolCall) => !toolCallNames.has(toolCall.name)),
    ],
  };
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

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
