import { type NextRequest, NextResponse } from 'next/server';
import { getVisiblePublicProject } from './admin-db';
import { getRequiredAdminSql } from './admin-sql';
import {
  type ChatResponse,
  createPublicChatMemoryRateLimiter,
  type PublicChatResponse,
  publicChatToolCallsFromPrivate,
} from './chat';
import {
  clientAcceptsPrivateChatStream,
  createPrivateChatSearchProgressEvent,
  encodePrivateChatStreamEvent,
} from './private-chat-stream';
import {
  isPrivateChatWorkflowAbortError,
  logPrivateChatWorkflowFailure,
  runPrivateChatSearchViaMastraWorkflow,
} from './private-chat-workflow-client';
import { isPublicWebChatSource, publicChatSourcesFromReport } from './public-chat-sources';
import {
  assertPublicReportAccess,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  getPublicReport,
  isSafePublicReportLocator,
  PublicReportNotFoundError,
  validatePrivateReportJson,
} from './report';
import { renderReportPdf } from './report-pdf';
import { createReportFetchContext, createReportPdfDownloadResponse } from './report-pdf-api';
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
 * Retrieves a public report in JSON format.
 *
 * @returns A JSON response containing the public report, a not-found error, or an internal error.
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
    const response = await getPublicReport({
      options: context.options,
      projectSlug: input.projectSlug,
      reportId: input.reportId,
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

/**
 * Creates a downloadable PDF for a public report.
 *
 * @param input - The public report locator and optional image data used in the PDF.
 * @returns A PDF download response, a 404 response when the report is not found, or a 500 response on unexpected errors.
 */
export async function handlePublicReportPdfPost(input: {
  readonly pufuImageDataUrl?: string;
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  if (!isSafePublicReportLocator(input)) {
    return publicReportNotFound();
  }

  try {
    const context = createReportFetchContext();
    const response = await getPublicReport({
      options: context.options,
      projectSlug: input.projectSlug,
      reportId: input.reportId,
    });
    const pdf = await renderReportPdf({
      projectSlug: input.projectSlug,
      pufuImageDataUrl: input.pufuImageDataUrl,
      report: response.report,
    });
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
 * Processes a chat question against a public report.
 *
 * @param request - The incoming request containing the chat question.
 * @param input - The public project and report locator.
 * @returns A streaming or JSON response containing public-safe progress and answer data, or an error response.
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
    const runWorkflow = (
      onStage?: Parameters<typeof runPrivateChatSearchViaMastraWorkflow>[0]['onStage'],
    ) =>
      runPrivateChatSearchViaMastraWorkflow({
        graphName: project.graphName,
        history: [],
        onStage,
        projectId: project.id,
        projectSlug: input.projectSlug,
        question,
        signal: request.signal,
      });
    const toPublicResponse = (chatResponse: ChatResponse): PublicChatResponse => ({
      answer: chatResponse.answer,
      ...(chatResponse.editing ? { editing: chatResponse.editing } : {}),
      projectSlug: input.projectSlug,
      reportId: input.reportId,
      sources: publicChatSourcesFromReport(
        chatResponse.sources.filter(isPublicWebChatSource),
        privateReport,
      ),
      status: 'answered',
      toolCalls: publicChatToolCallsFromPrivate(chatResponse.toolCalls),
    });

    if (clientAcceptsPrivateChatStream(request)) {
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const encoder = new TextEncoder();
          try {
            const chatResponse = await runWorkflow((stage) => {
              controller.enqueue(
                encoder.encode(
                  encodePrivateChatStreamEvent(createPrivateChatSearchProgressEvent(stage)),
                ),
              );
            });
            controller.enqueue(
              encoder.encode(
                encodePrivateChatStreamEvent({
                  response: toPublicResponse(chatResponse),
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
                  code: 'public_chat_internal_error',
                  message: 'An unexpected error occurred',
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

    try {
      return NextResponse.json(toPublicResponse(await runWorkflow()));
    } catch (error) {
      if (isPrivateChatWorkflowAbortError(error)) {
        throw error;
      }
      logPrivateChatWorkflowFailure(error);
      return publicChatErrorResponse(
        'public_chat_internal_error',
        'An unexpected error occurred',
        500,
      );
    }
  } catch (error) {
    if (error instanceof PublicReportNotFoundError) {
      return publicChatNotFound();
    }
    if (isPrivateChatWorkflowAbortError(error)) {
      return publicChatErrorResponse(
        'public_chat_internal_error',
        'An unexpected error occurred',
        500,
      );
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
