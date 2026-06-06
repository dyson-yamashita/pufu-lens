import { handlePublicReportGet } from '../../../../../../../src/public-report-api';

export async function GET(
  _request: Request,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;
  return handlePublicReportGet({ projectSlug, reportId });
}
