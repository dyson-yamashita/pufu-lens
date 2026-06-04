import { getAdminProject } from '../../../../src/admin-db';
import { businessHoursFromEnv, chatNowFromEnv, isWithinBusinessHours } from '../../../../src/chat';
import { ChatPanel } from '../../../../src/chat-client';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ProjectChatPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await getAdminProject(projectSlug);
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
      <PageHeader
        title={`${project.name} Chat`}
        subtitle="Indexed document、graph relation、raw / parsed metadata を source 付きで確認します。"
      />
      <ChatPanel disabled={!available} projectSlug={project.slug} />
    </AppShell>
  );
}
