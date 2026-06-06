import { type NextRequest, NextResponse } from 'next/server';
import {
  createExtractivePublicChatProvider,
  createGeminiPublicChatProvider,
  createPublicChatMemoryRateLimiter,
  runPublicChat,
} from './chat';
import {
  createReportStorageFromEnv,
  getPublicReport,
  getPublicReportArtifacts,
  isSafePublicReportLocator,
  PublicReportNotFoundError,
} from './report';

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
    const body = (await request.json()) as { question?: unknown };
    question = typeof body.question === 'string' ? body.question.trim() : '';
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
    const provider =
      process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL
        ? createGeminiPublicChatProvider({
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.GEMINI_CHAT_MODEL,
          })
        : createExtractivePublicChatProvider();
    const response = await runPublicChat(
      {
        clientIp: trustedClientIp(request),
        projectSlug: input.projectSlug,
        question,
        reportId: input.reportId,
      },
      {
        contextBundle: artifacts.contextBundle,
        provider,
        rateLimiters: [hourlyRateLimiter, dailyRateLimiter],
        report: artifacts.report,
      },
    );
    const status = response.status === 'rate_limited' ? 429 : 200;
    return NextResponse.json(response, { status });
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

function trustedClientIp(request: NextRequest): string {
  const nextRequestIp = (request as NextRequest & { readonly ip?: string }).ip?.trim();
  return nextRequestIp || 'anonymous';
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
