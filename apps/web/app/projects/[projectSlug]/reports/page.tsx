import { getAdminProject } from '../../../../src/admin-db';
import { ReportsList } from '../../../../src/report-client';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ReportsPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await getAdminProject(projectSlug);

  return (
    <AppShell active="reports" project={project}>
      <PageHeader
        title={`${project.name} Reports`}
        subtitle="生成済み private report の履歴、保存先、schema version を確認します。"
      />
      <section className="panel report-list-panel" data-testid="reports-list-panel">
        <div className="panel-heading">
          <div>
            <h2>Private Reports</h2>
            <p className="mono">GET /api/projects/{project.slug}/reports</p>
          </div>
          <button
            className="secondary-link"
            data-testid="reports-generate-button"
            disabled
            title="Report generation is available from the CLI in Step 13a"
            type="button"
          >
            Generate Report
          </button>
        </div>
        <ReportsList projectSlug={project.slug} />
      </section>
    </AppShell>
  );
}
