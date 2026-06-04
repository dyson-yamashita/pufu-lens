import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../../src/admin-sql';
import {
  businessHoursFromEnv,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
} from '../../../../../../src/chat';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  getPrivateReport,
  PublicReportNotFoundError,
  publishPublicReport,
  ReportNotFoundError,
  reportNowFromEnv,
  revokePublicReport,
} from '../../../../../../src/report';

export async function GET(
  _request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;
  const userId = process.env.PUFU_LENS_REPORT_USER_ID ?? process.env.PUFU_LENS_ADMIN_USER_ID;
  if (!userId) {
    return reportErrorResponse(
      'report_user_not_configured',
      'PUFU_LENS_REPORT_USER_ID is required',
      503,
    );
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
    return NextResponse.json(response, {
      status: response.status === 'db_outside_business_hours' ? 503 : 200,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProjectAccessDeniedError) {
      return reportErrorResponse('project_access_denied', message, 403);
    }
    if (error instanceof ReportNotFoundError) {
      return reportErrorResponse('report_not_found', message, 404);
    }
    console.error('Report Detail API Error:', error);
    return reportErrorResponse('report_internal_error', 'An unexpected error occurred', 500);
  }
}

export async function PATCH(
  request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;
  let body: { readonly isPublic?: boolean };
  try {
    body = (await request.json()) as { readonly isPublic?: boolean };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return reportErrorResponse('report_invalid_request', 'Invalid JSON body', 400);
    }
    throw error;
  }
  if (!body || typeof body.isPublic !== 'boolean') {
    return reportErrorResponse('report_invalid_request', 'isPublic must be boolean', 400);
  }

  const userId = process.env.PUFU_LENS_REPORT_USER_ID ?? process.env.PUFU_LENS_ADMIN_USER_ID;
  if (!userId) {
    return reportErrorResponse(
      'report_user_not_configured',
      'PUFU_LENS_REPORT_USER_ID is required',
      503,
    );
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
    const options = {
      businessHours,
      now,
      repository: createPostgresReportRepository(getRequiredAdminSql()),
      storage: createReportStorageFromEnv(),
    };
    const response = body.isPublic
      ? await publishPublicReport({ now, options, projectSlug, reportId, userId })
      : await revokePublicReport({ now, options, projectSlug, reportId, userId });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProjectAccessDeniedError) {
      return reportErrorResponse('project_access_denied', message, 403);
    }
    if (error instanceof ReportNotFoundError || error instanceof PublicReportNotFoundError) {
      return reportErrorResponse('report_not_found', message, 404);
    }
    console.error('Report Publish API Error:', error);
    return reportErrorResponse('report_internal_error', 'An unexpected error occurred', 500);
  }
}

function reportErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
