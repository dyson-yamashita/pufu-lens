import { NextResponse } from 'next/server';
import {
  ActivityPubAdminError,
  parseProjectFederationRequest,
  patchProjectFederation,
} from '../../../../../src/activitypub-admin';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';

/**
 * Enables or disables ActivityPub federation for a public project.
 *
 * @returns JSON federation state or a structured error response.
 */
export async function PATCH(
  request: Request,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;

  try {
    const userId = await requireSessionUserId();
    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return federationErrorResponse('invalid_body', 'Malformed JSON body', 400);
      }
      throw error;
    }
    const body = parseProjectFederationRequest(bodyJson);
    const response = await patchProjectFederation({
      sql: getRequiredAdminSql(),
      userId,
      projectSlug,
      body,
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return federationErrorResponse('auth_required', error.message, 401);
    }
    if (error instanceof ActivityPubAdminError) {
      return federationErrorResponse(error.code, error.message, error.status);
    }
    if (error instanceof Error && /Invalid project slug/.test(error.message)) {
      return federationErrorResponse('invalid_slug', error.message, 400);
    }
    if (error instanceof Error && /public/.test(error.message)) {
      return federationErrorResponse('project_not_public', error.message, 400);
    }
    console.error('Project federation API error');
    return federationErrorResponse(
      'activitypub_internal_error',
      'An unexpected error occurred',
      500,
    );
  }
}

function federationErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
