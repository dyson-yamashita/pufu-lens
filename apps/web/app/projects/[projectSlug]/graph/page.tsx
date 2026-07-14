import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import {
  getAdminProject,
  getProjectMembership,
  ProjectMembershipDeniedError,
  ProjectNotFoundError,
} from '../../../../src/admin-db';
import { listGraphPresets } from '../../../../src/graph-viewer';
import { GraphViewerPanel } from '../../../../src/graph-viewer-client';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ProjectGraphPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const [projectResult, session] = await Promise.all([
    getAdminProject(projectSlug)
      .then((project) => ({ project }))
      .catch((error: unknown) => ({ error })),
    auth(),
  ]);
  if ('error' in projectResult) {
    if (projectResult.error instanceof ProjectNotFoundError) {
      redirect('/projects');
    }
    throw projectResult.error;
  }
  const { project } = projectResult;
  const userId = session?.user?.id;
  let isMember = false;
  if (userId) {
    try {
      await getProjectMembership(projectSlug, userId);
      isMember = true;
    } catch (error) {
      if (!(error instanceof ProjectMembershipDeniedError)) {
        throw error;
      }
      if (project.visibility !== 'public') {
        redirect('/projects');
      }
    }
  } else if (project.visibility !== 'public') {
    redirect('/login');
  }

  const presets = listGraphPresets();
  const initialPreset = presets[0];
  if (!initialPreset) {
    throw new Error('Graph preset is not configured.');
  }

  if (!isMember) {
    return (
      <AppShell active="graph" project={project}>
        <PageHeader
          title={`${project.name} Graph`}
          subtitle="公開 project の graph を public API で確認します。"
        />
        <GraphViewerPanel
          graphApiPath={`/api/public/projects/${project.slug}/graph`}
          initialPresetId={initialPreset.id}
          loadDocumentChunks={false}
          presets={presets}
          projectSlug={project.slug}
        />
      </AppShell>
    );
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
