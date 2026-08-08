import { NextResponse } from 'next/server';
import {
  mapActivityPubAdminError,
  parseProjectFederationRequest,
  patchProjectFederation,
} from '../../../../../src/activitypub-admin';
import { getRequiredAdminSql } from '../../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../../src/auth-session';

/**
 * Enables or disables ActivityPub federation for a public project.
 *
 * Requires an authenticated session and project-admin authorization for the exact slug.
 * Rejects malformed JSON with 400 `invalid_body`, unauthenticated callers with 401 `auth_required`,
 * invalid slugs with 400 `invalid_slug`, forbidden access with 403 `forbidden`, private projects
 * with 400 `project_not_public`, username conflicts with 409 `preferred_username_conflict`, and
 * unexpected failures with 500 `activitypub_internal_error`.
 *
 * @returns JSON federation state on success or `{ error: { code, message } }` with the mapped HTTP status.
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
    const mapped = mapActivityPubAdminError(error);
    if (mapped.code === 'activitypub_internal_error') {
      console.error('Project federation API error');
    }
    return federationErrorResponse(mapped.code, mapped.message, mapped.status);
  }
}

function federationErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
