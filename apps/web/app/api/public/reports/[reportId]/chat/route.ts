import { type NextRequest, NextResponse } from 'next/server';
import { handlePublicChatPost } from '../../../../../../src/public-report-api';

export async function POST(
  request: NextRequest,
  { params }: { readonly params: Promise<{ readonly reportId: string }> },
) {
  const { reportId } = await params;
  const projectSlug = request.nextUrl.searchParams.get('projectSlug');
  if (!projectSlug) {
    return publicChatNotFound();
  }

  return handlePublicChatPost(request, { projectSlug, reportId });
}

function publicChatNotFound() {
  return publicChatErrorResponse('public_report_not_found', 'Public report not found', 404);
}

function publicChatErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
