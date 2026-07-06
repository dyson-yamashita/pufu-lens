import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { getAdminProject, getProjectMembership } from '../../../../src/admin-db';
import { businessHoursFromEnv, chatNowFromEnv, isWithinBusinessHours } from '../../../../src/chat';
import { ChatPanel, PublicProjectChatPanel } from '../../../../src/chat-client';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ProjectChatPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const [project, session] = await Promise.all([getAdminProject(projectSlug), auth()]);
  const userId = session?.user?.id;
  let isMember = false;
  if (userId) {
    try {
      await getProjectMembership(projectSlug, userId);
      isMember = true;
    } catch {
      if (project.visibility !== 'public') {
        redirect('/projects');
      }
    }
  } else if (project.visibility !== 'public') {
    redirect('/login');
  }
  if (!isMember) {
    return (
      <AppShell active="chat" project={project}>
        <PageHeader
          title={`${project.name} Chat`}
          subtitle="公開 project の chat を public API で確認します。"
        />
        <PublicProjectChatPanel projectSlug={project.slug} />
      </AppShell>
    );
  }
  const businessHours = businessHoursFromEnv(process.env);
  let available = false;
  try {
    available = isWithinBusinessHours(chatNowFromEnv(process.env) ?? new Date(), businessHours);
  } catch (error) {
    console.error('Failed to parse PUFU_LENS_CHAT_NOW, falling back to current time:', error);
    available = isWithinBusinessHours(new Date(), businessHours);
  }

  return (
    <AppShell active="chat" project={project}>
      <PageHeader title={`${project.name} Chat`} />
      <ChatPanel disabled={!available} projectSlug={project.slug} />
    </AppShell>
  );
}
