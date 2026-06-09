import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { getAdminProject, getProjectMembership } from '../../../../src/admin-db';
import { listGraphPresets } from '../../../../src/graph-viewer';
import { GraphViewerPanel } from '../../../../src/graph-viewer-client';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ProjectGraphPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const [project, session] = await Promise.all([getAdminProject(projectSlug), auth()]);
  const userId = session?.user?.id;
  if (!userId) {
    redirect('/login');
  }
  try {
    await getProjectMembership(projectSlug, userId);
  } catch {
    redirect('/projects');
  }

  const presets = listGraphPresets();

  return (
    <AppShell active="graph" project={project}>
      <PageHeader
        title={`${project.name} Graph`}
        subtitle="固定 query preset で project graph の node / edge を確認します。"
      />
      <GraphViewerPanel
        initialPresetId={presets[0]?.id ?? 'recent-relations'}
        presets={presets}
        projectSlug={project.slug}
      />
    </AppShell>
  );
}
