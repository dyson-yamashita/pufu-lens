import { NextResponse } from 'next/server';
import {
  createReportStorageFromEnv,
  getPublicReport,
  isSafePublicReportLocator,
  PublicReportNotFoundError,
} from '../../../../../src/report';

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly reportId: string }> },
) {
  const { reportId } = await params;
  const projectSlug = new URL(request.url).searchParams.get('projectSlug');
  if (!projectSlug || !isSafePublicReportLocator({ projectSlug, reportId })) {
    return publicReportNotFound();
  }

  try {
    const response = await getPublicReport({
      projectSlug,
      reportId,
      storage: createReportStorageFromEnv(),
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof PublicReportNotFoundError) {
      return publicReportNotFound();
    }
    console.error('Public Report API Error:', error);
    return NextResponse.json(
      { error: { code: 'public_report_internal_error', message: 'An unexpected error occurred' } },
      { status: 500 },
    );
  }
}

function publicReportNotFound() {
  return NextResponse.json(
    { error: { code: 'public_report_not_found', message: 'Public report not found' } },
    { status: 404 },
  );
}
