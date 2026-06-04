import { getAdminProject } from '../../../../../src/admin-db';
import { ReportDocument } from '../../../../../src/report-client';
import { AppShell, PageHeader } from '../../../../../src/ui';

export default async function ReportDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string; readonly reportId: string }>;
}) {
  const { projectSlug, reportId } = await params;
  const project = await getAdminProject(projectSlug);

  return (
    <AppShell active="reports" project={project}>
      <PageHeader title="Private Report" subtitle={`${project.name} / ${reportId}`} />
      <ReportDocument projectSlug={project.slug} reportId={reportId} />
    </AppShell>
  );
}
