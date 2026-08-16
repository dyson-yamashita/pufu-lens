import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { ActivityPubProfilePanel } from '../../src/activitypub-profile-panel';
import { readServerActivityPubProfileSettings } from '../../src/activitypub-profile-settings';
import { getRequiredAdminSql } from '../../src/admin-sql';
import { lookupGlobalAdminUserId } from '../../src/authz.ts';
import { AppShell, PageHeader } from '../../src/ui';

/**
 * Renders global app settings for ActivityPub aggregate profile management.
 * Accessible only to authenticated global app admins.
 */
export default async function AppSettingsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect('/login');
  }
  const sql = getRequiredAdminSql();
  const adminUserId = await lookupGlobalAdminUserId(sql, { userId });
  if (!adminUserId) {
    redirect('/projects');
  }
  const profileSettings = await readServerActivityPubProfileSettings(sql, {
    canManage: Boolean(adminUserId),
  });

  return (
    <AppShell active="app-settings">
      <PageHeader title="Settings" subtitle="サーバー全体の ActivityPub 設定を管理します。" />
      <ActivityPubProfilePanel scope="aggregate" settings={profileSettings} />
    </AppShell>
  );
}
