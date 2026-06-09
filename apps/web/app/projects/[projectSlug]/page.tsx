import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth';
import {
  getAdminProject,
  getProjectMembership,
  getVisiblePublicProject,
} from '../../../src/admin-db';
import { AppShell, MetricStrip, PageHeader } from '../../../src/ui';

export default async function ProjectOverviewPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const [project, session] = await Promise.all([getAdminProject(projectSlug), auth()]);
  const userId = session?.user?.id;
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
  const publicProject =
    project.visibility === 'public' ? await getVisiblePublicProject(project.slug) : undefined;

  return (
    <AppShell active="projects" project={project}>
      <PageHeader title={project.name} subtitle="プロジェクトの report と chat への入口です。" />
      <section className="panel" data-testid="project-overview-panel">
        <div className="project-card-header">
          <div>
            <p className="eyebrow">{project.slug}</p>
            <h2>Project Overview</h2>
          </div>
          <span
            className={`status-badge status-visibility-${project.visibility}`}
            data-testid={`project-overview-visibility-${project.slug}`}
          >
            {project.visibility}
          </span>
        </div>
        {isMember ? <MetricStrip project={project} /> : null}
        <p className="notice" data-testid="project-overview-tab-notice">
          Reports と Chat は左のタブから開けます。
        </p>
      </section>
      {publicProject?.reports.length ? (
        <section className="panel" data-testid="project-overview-public-reports">
          <div className="panel-heading">
            <div>
              <h2>Public Reports</h2>
              <p className="mono">{project.slug}</p>
            </div>
          </div>
          <div className="source-list">
            {publicProject.reports.map((report) => (
              <Link
                className="source-chip"
                data-testid={`project-overview-public-report-${report.id}`}
                href={`/reports/public/${project.slug}/${report.id}`}
                key={report.id}
              >
                <strong>{report.title}</strong>
                <span>{report.summary}</span>
                <small>{report.publishedAt}</small>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}
