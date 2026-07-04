import Link from 'next/link';
import { redirect } from 'next/navigation';
import { generatePrivateReport } from '../../../../src/admin-actions';
import {
  getAdminProject,
  getProjectMembership,
  getVisiblePublicProject,
} from '../../../../src/admin-db';
import { getOptionalAdminSql } from '../../../../src/admin-sql';
import { AuthRequiredError, requireSessionUserId } from '../../../../src/auth-session';
import { lookupProjectAdminAccess } from '../../../../src/authz';
import {
  createPostgresReportRepository,
  reportNowFromEnv,
  resolveReportPeriod,
} from '../../../../src/report';
import { ReportGenerateForm, ReportsList } from '../../../../src/report-client';
import { formatReportSummaryPreview } from '../../../../src/report-summary';
import { AppShell, PageHeader } from '../../../../src/ui';

/**
 * Renders the reports page for a project, showing public reports to non-members and private report tools to members.
 *
 * @param params - A promise that resolves to the project slug route parameters.
 * @returns The reports page content for the project.
 */
export default async function ReportsPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await getAdminProject(projectSlug);
  let userId: string | undefined;
  try {
    userId = await requireSessionUserId();
  } catch (error) {
    if (!(error instanceof AuthRequiredError)) {
      throw error;
    }
  }

  let isMember = false;
  if (userId) {
    try {
      await getProjectMembership(projectSlug, userId);
      isMember = true;
    } catch {
      if (project.visibility !== 'public') {
        redirect('/projects');
      }
    }
  } else if (project.visibility !== 'public') {
    redirect('/login');
  }

  if (!isMember) {
    const publicProject = await getVisiblePublicProject(project.slug);

    return (
      <AppShell active="reports" project={project}>
        <PageHeader
          title={`${project.name} Reports`}
          subtitle="公開されている report を確認します。"
        />
        <section className="panel report-list-panel" data-testid="public-reports-list-panel">
          <div className="panel-heading">
            <div>
              <h2>Public Reports</h2>
              <p className="mono">{project.slug}</p>
            </div>
          </div>
          {publicProject?.reports.length ? (
            <div className="source-list">
              {publicProject.reports.map((report) => (
                <Link
                  className="source-chip"
                  data-testid={`public-report-${project.slug}-${report.id}`}
                  href={`/reports/public/${project.slug}/${report.id}`}
                  key={report.id}
                >
                  <strong>{report.title}</strong>
                  <span>{formatReportSummaryPreview(report.summary)}</span>
                  <small>{report.publishedAt}</small>
                </Link>
              ))}
            </div>
          ) : (
            <p className="notice" data-testid="public-reports-empty">
              公開されている report はまだありません。
            </p>
          )}
        </section>
      </AppShell>
    );
  }

  const defaultPeriod = resolveReportPeriod(reportNowFromEnv(process.env) ?? new Date(), 'weekly');
  const sql = getOptionalAdminSql();
  const adminAccess =
    sql && userId ? await lookupProjectAdminAccess(sql, { projectSlug, userId }) : undefined;
  const customTemplates =
    sql && adminAccess
      ? ((await createPostgresReportRepository(sql).listActiveCustomReportTemplates?.({
          projectId: adminAccess.id,
        })) ?? [])
      : [];

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
          <ReportGenerateForm
            action={generatePrivateReport}
            customTemplates={customTemplates}
            defaultPeriod={defaultPeriod}
            projectSlug={project.slug}
          />
        </div>
        <ReportsList projectSlug={project.slug} />
      </section>
    </AppShell>
  );
}
