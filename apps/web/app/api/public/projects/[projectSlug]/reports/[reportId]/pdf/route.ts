import { handlePublicReportPdfPost } from '../../../../../../../../src/public-report-api';

/**
 * Handles public report PDF requests.
 *
 * @param params - Route parameters containing the project slug and report ID.
 * @returns The response for the requested public report PDF.
 */
export async function POST(
  request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;
  const body = (await request.json()) as { readonly pufuImageDataUrl?: unknown };
  return handlePublicReportPdfPost({
    projectSlug,
    pufuImageDataUrl: typeof body.pufuImageDataUrl === 'string' ? body.pufuImageDataUrl : undefined,
    reportId,
  });
}
