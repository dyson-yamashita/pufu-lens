import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import type { ProjectSummary } from '../../../../src/admin-data';
import { getProjectMembership } from '../../../../src/admin-db';
import { listGraphPresets } from '../../../../src/graph-viewer';
import { GraphViewerPanel } from '../../../../src/graph-viewer-client';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ProjectGraphPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect('/login');
  }
  let project: ProjectSummary;
  try {
    const membership = await getProjectMembership(projectSlug, userId);
    project = membership.project;
  } catch {
    redirect('/projects');
  }

  const presets = listGraphPresets();
  const initialPreset = presets[0];
  if (!initialPreset) {
    throw new Error('Graph preset is not configured.');
  }

  return (
    <AppShell active="graph" project={project}>
      <PageHeader
        title={`${project.name} Graph`}
        subtitle="固定 query preset で project graph の node / edge を確認します。"
      />
      <GraphViewerPanel
        initialPresetId={initialPreset.id}
        presets={presets}
        projectSlug={project.slug}
      />
    </AppShell>
  );
}
