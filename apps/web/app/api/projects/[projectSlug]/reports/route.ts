import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import { createPostgresReportRepository, listPrivateReports } from '../../../../../src/report';

/**
 * Lists private reports for an authenticated user and project.
 *
 * @returns A JSON response containing the private reports or an error response.
 */
export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;

  try {
    const userId = await requireSessionUserId();
    const response = await listPrivateReports({
      options: {
        repository: createPostgresReportRepository(getRequiredAdminSql()),
      },
      projectSlug,
      userId,
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return reportErrorResponse('auth_required', error.message, 401);
    }
    console.error('Reports List API Error:', error);
    return reportErrorResponse('report_internal_error', 'An unexpected error occurred', 500);
  }
}

function reportErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
