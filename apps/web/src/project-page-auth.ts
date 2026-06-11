import { redirect } from 'next/navigation';
import { getProjectMembership } from './admin-db';
import { getSessionUserId } from './auth-session';

export async function requireProjectAdminPage(projectSlug: string) {
  const userId = await getSessionUserId();
  if (!userId) {
    redirect('/login');
  }

  let membership: Awaited<ReturnType<typeof getProjectMembership>>;
  try {
    membership = await getProjectMembership(projectSlug, userId);
  } catch {
    redirect('/projects');
  }

  if (!membership.canManageMembers) {
    redirect(`/projects/${projectSlug}`);
  }
  return membership.project;
}
