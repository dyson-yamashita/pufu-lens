import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { getAdminProject, getProjectMembership } from '../../../../src/admin-db';
import { ChatPanel, PublicProjectChatPanel } from '../../../../src/chat-client';
import { AppShell, PageHeader } from '../../../../src/ui';

/**
 * Renders the project chat page for authenticated members and public visitors.
 *
 * @param params - Route parameters containing the project slug.
 * @returns The project chat page with member or public chat access.
 */
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
        <PublicProjectChatPanel projectName={project.name} projectSlug={project.slug} />
      </AppShell>
    );
  }
  return (
    <AppShell active="chat" project={project}>
      <PageHeader title={`${project.name} Chat`} />
      <ChatPanel projectName={project.name} projectSlug={project.slug} />
    </AppShell>
  );
}
