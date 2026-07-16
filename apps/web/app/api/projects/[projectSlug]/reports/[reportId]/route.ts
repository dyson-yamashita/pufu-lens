import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../../src/auth-session';
import { ProjectAccessDeniedError } from '../../../../../../src/chat';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  deletePrivateReport,
  getPrivateReport,
  PublicReportNotFoundError,
  publishPublicReport,
  ReportNotFoundError,
  reportNowFromEnv,
  revokePublicReport,
} from '../../../../../../src/report';

/**
 * Retrieves a private report for the authenticated user.
 *
 * @returns A JSON response containing the report or an appropriate error response.
 */
export async function GET(
  _request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;

  try {
    const userId = await requireSessionUserId();
    const response = await getPrivateReport({
      options: {
        repository: createPostgresReportRepository(getRequiredAdminSql()),
        storage: createReportStorageFromEnv(),
      },
      projectSlug,
      reportId,
      userId,
    });
    return NextResponse.json(response);
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
    console.error('Report Detail API Error:', error);
    return reportErrorResponse('report_internal_error', 'An unexpected error occurred', 500);
  }
}

/**
 * Updates a report's public visibility.
 *
 * @param request - Request containing a JSON body with an `isPublic` boolean.
 * @returns The updated report or a structured error response.
 */
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

  try {
    const userId = await requireSessionUserId();
    const now = reportNowFromEnv(process.env) ?? new Date();
    const options = {
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
    if (error instanceof AuthRequiredError) {
      return reportErrorResponse('auth_required', message, 401);
    }
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

/**
 * Deletes a private report for the authenticated user.
 *
 * @returns The deletion result or a JSON error response.
 */
export async function DELETE(
  _request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;

  try {
    const userId = await requireSessionUserId();
    const now = reportNowFromEnv(process.env) ?? new Date();
    const response = await deletePrivateReport({
      options: {
        now,
        repository: createPostgresReportRepository(getRequiredAdminSql()),
        storage: createReportStorageFromEnv(),
      },
      projectSlug,
      reportId,
      userId,
    });
    return NextResponse.json(response);
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
    console.error('Report Delete API Error:', error);
    return reportErrorResponse('report_internal_error', 'An unexpected error occurred', 500);
  }
}
