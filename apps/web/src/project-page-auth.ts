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
    redirect(`/projects/${membership.project.slug}`);
  }
  return membership.project;
}

/** Requires an authenticated project member and returns the project summary. */
export async function requireProjectMemberPage(projectSlug: string) {
  const userId = await getSessionUserId();
  if (!userId) {
    redirect('/login');
  }

  try {
    const membership = await getProjectMembership(projectSlug, userId);
    return membership.project;
  } catch {
    redirect('/projects');
  }
}
