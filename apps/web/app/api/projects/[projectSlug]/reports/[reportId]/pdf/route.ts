import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../../src/auth-session';
import {
  businessHoursFromEnv,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
} from '../../../../../../../src/chat';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  getPrivateReport,
  ReportNotFoundError,
  reportNowFromEnv,
} from '../../../../../../../src/report';
import { renderReportPdf } from '../../../../../../../src/report-pdf';

export async function GET(
  _request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;

  try {
    const userId = await requireSessionUserId();
    const businessHours = businessHoursFromEnv(process.env);
    const now = reportNowFromEnv(process.env) ?? new Date();
    if (!isWithinBusinessHours(now, businessHours)) {
      return NextResponse.json(
        { report: null, status: 'db_outside_business_hours' },
        { status: 503 },
      );
    }
    const response = await getPrivateReport({
      options: {
        businessHours,
        now,
        repository: createPostgresReportRepository(getRequiredAdminSql()),
        storage: createReportStorageFromEnv(),
      },
      projectSlug,
      reportId,
      userId,
    });
    if (response.status === 'db_outside_business_hours') {
      return NextResponse.json(response, { status: 503 });
    }
    const pdf = await renderReportPdf({ projectSlug, report: response.report });
    return new NextResponse(pdf.bytes, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${pdf.fileName}"`,
        'Content-Type': 'application/pdf',
      },
      status: 200,
    });
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

function reportErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
