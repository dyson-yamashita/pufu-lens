import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { businessHoursFromEnv, isWithinBusinessHours } from '../../../../../src/chat';
import {
  createPostgresReportRepository,
  listPrivateReports,
  reportNowFromEnv,
} from '../../../../../src/report';

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
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
        { reports: [], status: 'db_outside_business_hours' },
        { status: 503 },
      );
    }
    const response = await listPrivateReports({
      options: {
        businessHours,
        now,
        repository: createPostgresReportRepository(getRequiredAdminSql()),
      },
      projectSlug,
      userId,
    });
    return NextResponse.json(response, {
      status: response.status === 'db_outside_business_hours' ? 503 : 200,
    });
  } catch (error) {
    console.error('Reports List API Error:', error);
    return reportErrorResponse('report_internal_error', 'An unexpected error occurred', 500);
  }
}

function reportErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
