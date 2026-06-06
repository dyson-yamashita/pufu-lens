import type { NextRequest } from 'next/server';
import { handlePublicChatPost } from '../../../../../../../../src/public-report-api';

export async function POST(
  request: NextRequest,
  {
    params,
  }: { readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }> },
) {
  const { projectSlug, reportId } = await params;
  return handlePublicChatPost(request, { projectSlug, reportId });
}
