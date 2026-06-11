import { type NextRequest, NextResponse } from 'next/server';
import type { SourceType } from '../../../../../src/admin-data';
import {
  connectionErrorSettingsUrl,
  googleConnectionStartUrl,
} from '../../../../../src/project-connections';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const projectSlug = request.nextUrl.searchParams.get('projectSlug');
  const sourceType = parseSourceType(request.nextUrl.searchParams.get('sourceType'));
  if (!projectSlug) {
    return NextResponse.redirect(new URL('/projects?connectionError=missing-project', request.url));
  }
  try {
    return NextResponse.redirect(
      await googleConnectionStartUrl({ projectSlug, sourceType: sourceType ?? undefined }),
    );
  } catch (error) {
    return NextResponse.redirect(
      new URL(connectionErrorSettingsUrl(projectSlug, error), request.url),
    );
  }
}

function parseSourceType(value: string | null): SourceType | null {
  if (value === 'drive' || value === 'gmail') {
    return value;
  }
  return null;
}
