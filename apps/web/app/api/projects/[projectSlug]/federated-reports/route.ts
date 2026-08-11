import { NextResponse } from 'next/server';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';
import {
  createFederatedReportsHttpResponse,
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
    return toFederatedReportsNextResponse(createFederatedReportsHttpResponse(response));
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return toFederatedReportsNextResponse(
        createFederatedReportsHttpResponse(
          { error: { code: 'auth_required', message: error.message } },
          401,
        ),
      );
    }
    if (error instanceof FederatedReportsForbiddenError) {
      return toFederatedReportsNextResponse(
        createFederatedReportsHttpResponse(
          { error: { code: 'forbidden', message: 'Forbidden' } },
          403,
        ),
      );
    }
    console.error('federated_reports_api_error');
    return toFederatedReportsNextResponse(
      createFederatedReportsHttpResponse(
        {
          error: {
            code: 'federated_reports_internal_error',
            message: 'An unexpected error occurred',
          },
        },
        500,
      ),
    );
  }
}

function toFederatedReportsNextResponse(response: {
  readonly body: unknown;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}) {
  return NextResponse.json(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
