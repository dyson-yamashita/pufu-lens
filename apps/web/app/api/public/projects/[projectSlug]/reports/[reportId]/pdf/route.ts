import { handlePublicReportPdfPost } from '../../../../../../../../src/public-report-api';
import { reportPdfImageDataUrlFromRequest } from '../../../../../../../../src/report-pdf';

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
  return handlePublicReportPdfPost({
    projectSlug,
    pufuImageDataUrl: await reportPdfImageDataUrlFromRequest(request),
    reportId,
  });
}
