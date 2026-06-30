import { type NextRequest, NextResponse } from 'next/server';
import { getVisiblePublicProject } from './admin-db';
import { getRequiredAdminSql } from './admin-sql';
import {
  businessHoursFromEnv,
  type ChatSource,
  chatNowFromEnv,
  createPublicChatMemoryRateLimiter,
  isWithinBusinessHours,
  type PublicChatResponse,
  type PublicChatSource,
  type PublicChatToolCall,
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
  type PrivateReportJsonV1,
  PublicReportNotFoundError,
  validatePrivateReportJson,
} from './report';
import { renderReportPdf } from './report-pdf';
import {
  createReportFetchContext,
  createReportPdfDownloadResponse,
  isOutsideReportBusinessHours,
  reportOutsideBusinessHoursResponse,
} from './report-pdf-api';
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

/**
 * Fetches a public report in JSON format.
 *
 * @returns The public report response, or an error response when the report is unavailable or an unexpected error occurs.
 */
export async function handlePublicReportGet(input: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  if (!isSafePublicReportLocator(input)) {
    return publicReportNotFound();
  }

  try {
    const context = createReportFetchContext();
    if (isOutsideReportBusinessHours(context)) {
      return reportOutsideBusinessHoursResponse();
    }
    const response = await getPublicReport({
      options: context.options,
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

/**
 * Returns a downloadable PDF for a public report.
 *
 * @param input - The public report locator.
 * @returns A PDF download response, a 404 response when the report is not found, a 503 response when the report is unavailable outside business hours, or a 500 response on unexpected errors.
 */
export async function handlePublicReportPdfGet(input: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  if (!isSafePublicReportLocator(input)) {
    return publicReportNotFound();
  }

  try {
    const context = createReportFetchContext();
    if (isOutsideReportBusinessHours(context)) {
      return reportOutsideBusinessHoursResponse();
    }
    const response = await getPublicReport({
      options: context.options,
      projectSlug: input.projectSlug,
      reportId: input.reportId,
    });
    if (response.status === 'db_outside_business_hours') {
      return reportOutsideBusinessHoursResponse();
    }
    const pdf = await renderReportPdf({ projectSlug: input.projectSlug, report: response.report });
    return createReportPdfDownloadResponse(pdf);
  } catch (error) {
    if (error instanceof PublicReportNotFoundError) {
      return publicReportNotFound();
    }
    console.error('Public Report PDF API Error:', error);
    return NextResponse.json(
      {
        error: {
          code: 'public_report_pdf_internal_error',
          message: 'An unexpected error occurred',
        },
      },
      { status: 500 },
    );
  }
}

/**
 * Processes a public chat request for a report.
 *
 * @param input - The public project and report locator.
 * @returns A JSON response containing the chat answer and public sources, or an error response for invalid input, access failures, rate limits, or internal errors.
 */
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
          reportId: input.reportId,
          sources: [],
          status: 'db_outside_business_hours',
          toolCalls: [],
        },
        { status: 503 },
      );
    }
    const repository = createPostgresReportRepository(getRequiredAdminSql());
    const { metadata, project } = await assertPublicReportAccess({
      projectSlug: input.projectSlug,
      reportId: input.reportId,
      repository,
    });
    const privateReport = JSON.parse(
      await createReportStorageFromEnv().getText(metadata.storageUri),
    ) as unknown;
    validatePrivateReportJson(privateReport);
    if (privateReport.report_id !== input.reportId || privateReport.project_id !== project.id) {
      throw new PublicReportNotFoundError(input.reportId);
    }
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
    const chatResponse = mastraGenerateToChatResponse({
      mastraResponse: mastraBody,
      projectSlug: input.projectSlug,
      question,
    });
    return NextResponse.json({
      answer: chatResponse.answer,
      ...(chatResponse.editing ? { editing: chatResponse.editing } : {}),
      projectSlug: input.projectSlug,
      reportId: input.reportId,
      sources: publicChatSourcesFromReport(chatResponse.sources, privateReport),
      status: 'answered',
      toolCalls: publicChatToolCalls(chatResponse.toolCalls),
    } satisfies PublicChatResponse);
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

function publicChatSourcesFromReport(
  chatSources: readonly ChatSource[],
  report: PrivateReportJsonV1,
): PublicChatSource[] {
  const references = new Map<string, PublicChatSource>();
  for (const section of report.sections) {
    section.sources?.forEach((source, index) => {
      if (!references.has(source.document_id)) {
        references.set(source.document_id, {
          label: source.title?.trim() || source.doc_type,
          publicSourceId: `src_${section.id}_${index + 1}`,
          sectionId: section.id,
        });
      }
    });
  }
  report.pufu_sources?.forEach((source, index) => {
    if (!references.has(source.document_id)) {
      references.set(source.document_id, {
        label: source.title,
        publicSourceId: `src_pufu_${index + 1}`,
        sectionId: 'pufu_sources',
      });
    }
  });

  const result: PublicChatSource[] = [];
  const seen = new Set<string>();
  for (const source of chatSources) {
    const publicSource = references.get(source.documentId);
    if (publicSource && !seen.has(publicSource.publicSourceId)) {
      result.push(publicSource);
      seen.add(publicSource.publicSourceId);
    }
  }
  return result;
}

function publicChatToolCalls(
  toolCalls: readonly { readonly resultCount: number }[],
): PublicChatToolCall[] {
  const resultCount = toolCalls.reduce((total, toolCall) => total + toolCall.resultCount, 0);
  return resultCount > 0 ? [{ name: 'public-report-fetch', resultCount }] : [];
}
