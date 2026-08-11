import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  FederatedReportsForbiddenError,
  listProjectFederatedReports,
} from '../../../../../src/federated-report-api';

/**
 * Lists federated inbound reports for an authenticated project member.
 *
 * @returns JSON with status, reports, and blockedCount or a safe error response.
 */
export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;

  try {
    const userId = await requireSessionUserId();
    const response = await listProjectFederatedReports({
      sql: getRequiredAdminSql(),
      userId,
      projectSlug,
      blockedDomainsEnv: process.env.ACTIVITYPUB_BLOCKED_DOMAINS,
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return federatedReportErrorResponse('auth_required', error.message, 401);
    }
    if (error instanceof FederatedReportsForbiddenError) {
      return federatedReportErrorResponse('forbidden', 'Forbidden', 403);
    }
    console.error('federated_reports_api_error');
    return federatedReportErrorResponse(
      'federated_reports_internal_error',
      'An unexpected error occurred',
      500,
    );
  }
}

function federatedReportErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
