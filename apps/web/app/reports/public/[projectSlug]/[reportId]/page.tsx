import { listGraphPresets } from '../../../../../src/graph-viewer';
import { GraphViewerPanel } from '../../../../../src/graph-viewer-client';
import { PublicReportDocument } from '../../../../../src/report-client';
import { AppShell, PageHeader } from '../../../../../src/ui';

export default async function PublicReportPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }>;
}) {
  const { projectSlug, reportId } = await params;
  const projectName = publicProjectName(projectSlug);
  const presets = listGraphPresets();
  const initialPreset = presets[0];
  if (!initialPreset) {
    throw new Error('Graph preset is not configured.');
  }

  return (
    <AppShell active="reports" project={publicProjectSummary(projectSlug, projectName)}>
      <PageHeader title="Public Report" subtitle={`${projectName} / ${reportId}`} />
      <PublicReportDocument projectSlug={projectSlug} reportId={reportId} />
      <GraphViewerPanel
        graphApiPath={`/api/public/projects/${projectSlug}/graph`}
        initialPresetId={initialPreset.id}
        loadDocumentChunks={false}
        presets={presets}
        projectSlug={projectSlug}
      />
    </AppShell>
  );
}

function publicProjectSummary(slug: string, name: string) {
  return {
    dataSources: [],
    description: null,
    failedCount: 0,
    heldCount: 0,
    ingestedCount: 0,
    lastIndexed: '',
    memberCount: 0,
    name,
    parserProfiles: [],
    queueCount: 0,
    rawCount: 0,
    slug,
    status: 'active' as const,
    visibility: 'public' as const,
  };
}

function publicProjectName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
