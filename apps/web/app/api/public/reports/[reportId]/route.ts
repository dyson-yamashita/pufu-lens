import { NextResponse } from 'next/server';
import { handlePublicReportGet } from '../../../../../src/public-report-api';

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly reportId: string }> },
) {
  const { reportId } = await params;
  const projectSlug = new URL(request.url).searchParams.get('projectSlug');
  if (!projectSlug) {
    return publicReportNotFound();
  }

  return handlePublicReportGet({ projectSlug, reportId });
}

function publicReportNotFound() {
  return NextResponse.json(
    { error: { code: 'public_report_not_found', message: 'Public report not found' } },
    { status: 404 },
  );
}
