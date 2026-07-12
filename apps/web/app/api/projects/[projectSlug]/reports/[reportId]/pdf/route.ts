import { NextResponse } from 'next/server';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../../src/auth-session';
import { ProjectAccessDeniedError } from '../../../../../../../src/chat';
import { getPrivateReport, ReportNotFoundError } from '../../../../../../../src/report';
import {
  renderReportPdf,
  reportPdfImageDataUrlFromRequest,
} from '../../../../../../../src/report-pdf';
import {
  createReportFetchContext,
  createReportPdfDownloadResponse,
  isOutsideReportBusinessHours,
  reportOutsideBusinessHoursResponse,
} from '../../../../../../../src/report-pdf-api';

/**
 * Generates a PDF for a private project report.
 *
 * @param params - Route parameters containing the project slug and report ID.
 * @returns A PDF download, or a JSON error response when the report cannot be retrieved or rendered.
 */
export async function POST(
  request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;

  try {
    const userId = await requireSessionUserId();
    const context = createReportFetchContext();
    if (isOutsideReportBusinessHours(context)) {
      return reportOutsideBusinessHoursResponse();
    }
    const response = await getPrivateReport({
      options: context.options,
      projectSlug,
      reportId,
      userId,
    });
    if (response.status === 'db_outside_business_hours') {
      return reportOutsideBusinessHoursResponse();
    }
    const pdf = await renderReportPdf({
      projectSlug,
      pufuImageDataUrl: await reportPdfImageDataUrlFromRequest(request),
      report: response.report,
    });
    return createReportPdfDownloadResponse(pdf);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthRequiredError) {
      return reportErrorResponse('auth_required', message, 401);
    }
    if (error instanceof ProjectAccessDeniedError) {
      return reportErrorResponse('project_access_denied', message, 403);
    }
    if (error instanceof ReportNotFoundError) {
      return reportErrorResponse('report_not_found', message, 404);
    }
    console.error('Report PDF API Error:', error);
    return reportErrorResponse('report_pdf_internal_error', 'An unexpected error occurred', 500);
  }
}

/**
 * Creates a standardized JSON error response.
 *
 * @param code - The error code to include in the response.
 * @param message - The error message to include in the response.
 * @param status - The HTTP status code for the response.
 * @returns A JSON response containing the error payload.
 */
function reportErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
