import type { NextRequest } from 'next/server';
import { handlePublicProjectChatPost } from '../../../../../../src/public-report-api';

export async function POST(
  request: NextRequest,
  { params }: { readonly params: Promise<{ readonly projectSlug: string }> },
) {
  const { projectSlug } = await params;
  return handlePublicProjectChatPost(request, { projectSlug });
}
