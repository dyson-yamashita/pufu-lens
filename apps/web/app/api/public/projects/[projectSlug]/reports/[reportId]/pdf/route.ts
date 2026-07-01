import { handlePublicReportPdfGet } from '../../../../../../../../src/public-report-api';

/**
 * Handles public report PDF requests.
 *
 * @param params - Route parameters containing the project slug and report ID.
 * @returns The response for the requested public report PDF.
 */
export async function GET(
  _request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;
  return handlePublicReportPdfGet({ projectSlug, reportId });
}
