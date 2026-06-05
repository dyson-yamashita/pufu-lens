import { generatePrivateReport } from '../../../../src/admin-actions';
import { getAdminProject } from '../../../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../../../src/form-buttons';
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
          <ActionForm action={generatePrivateReport}>
            <input name="projectSlug" type="hidden" value={project.slug} />
            <PendingSubmitButton
              className="secondary-link"
              testId="reports-generate-button"
              title="Generate private report"
            >
              Generate Report
            </PendingSubmitButton>
          </ActionForm>
        </div>
        <ReportsList projectSlug={project.slug} />
      </section>
    </AppShell>
  );
}
