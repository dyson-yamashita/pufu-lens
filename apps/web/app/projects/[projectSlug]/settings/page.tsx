import { ActivityPubSubscriptionPanel } from '../../../../src/activitypub-subscription-panel';
import { readProjectActivityPubSubscriptionSettings } from '../../../../src/activitypub-subscription-settings';
import { getRequiredAdminSql } from '../../../../src/admin-sql';
import { requireProjectMemberPage } from '../../../../src/project-page-auth';
import { AppShell, PageHeader } from '../../../../src/ui';

/**
 * Member-readable project settings page with ActivityPub subscription status.
 */
export default async function ProjectMemberSettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await requireProjectMemberPage(projectSlug);
  const sql = getRequiredAdminSql();
  const subscriptionSettings = await readProjectActivityPubSubscriptionSettings(sql, {
    projectSlug: project.slug,
  });

  return (
    <AppShell active="settings" project={project}>
      <PageHeader
        title={`${project.name} Settings`}
        subtitle="プロジェクトの ActivityPub 購読状態を確認できます。"
      />
      <ActivityPubSubscriptionPanel
        canManage={false}
        projectSlug={project.slug}
        settings={subscriptionSettings}
      />
    </AppShell>
  );
}
