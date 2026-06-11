import { type NextRequest, NextResponse } from 'next/server';
import {
  connectionErrorSettingsUrl,
  githubConnectionStartUrl,
} from '../../../../../src/project-connections';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const projectSlug = request.nextUrl.searchParams.get('projectSlug');
  if (!projectSlug) {
    return NextResponse.redirect(new URL('/projects?connectionError=missing-project', request.url));
  }
  try {
    return NextResponse.redirect(await githubConnectionStartUrl({ projectSlug }));
  } catch (error) {
    return NextResponse.redirect(
      new URL(connectionErrorSettingsUrl(projectSlug, error), request.url),
    );
  }
}
