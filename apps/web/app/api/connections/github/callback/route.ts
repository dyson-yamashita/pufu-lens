import { type NextRequest, NextResponse } from 'next/server';
import {
  appBaseUrl,
  completeGithubConnection,
  connectionErrorSettingsUrl,
} from '../../../../../src/project-connections';

export async function GET(request: NextRequest): Promise<NextResponse> {
  let projectSlug: string | null = null;
  try {
    const state = request.nextUrl.searchParams.get('state');
    if (state) {
      const payload = state.split('.')[0];
      if (payload) {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
          readonly projectSlug?: string;
        };
        projectSlug = parsed.projectSlug ?? null;
      }
    }
    return NextResponse.redirect(new URL(await completeGithubConnection(request), appBaseUrl()));
  } catch (error) {
    return NextResponse.redirect(
      new URL(connectionErrorSettingsUrl(projectSlug, error), appBaseUrl()),
    );
  }
}
