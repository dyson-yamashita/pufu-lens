import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '../../../auth';
import {
  getAdminProject,
  getProjectMembership,
  getVisiblePublicProject,
  ProjectNotFoundError,
} from '../../../src/admin-db';
import { getOptionalAdminSql } from '../../../src/admin-sql';
import { loadLatestProjectOverview } from '../../../src/project-overview-data';
import {
  ProjectOverviewEmptyState,
  ProjectOverviewErrorState,
  ProjectOverviewSection,
} from '../../../src/project-overview-section';
import { createPostgresReportRepository } from '../../../src/report';
import { createReportStorageFromEnv } from '../../../src/report-storage';
import { formatReportSummaryPreview } from '../../../src/report-summary';
import { AppShell, MetricStrip, PageHeader } from '../../../src/ui';

export default async function ProjectOverviewPage({
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
    if (!isUnknownProjectError(projectResult.error)) {
      throw projectResult.error;
    }
    notFound();
  }
  const { project } = projectResult;
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
  const overviewResult = await loadProjectOverview({
    isMember,
    projectSlug: project.slug,
  });

  return (
    <AppShell active="overview" project={project}>
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
        {project.description ? (
          <p data-testid="project-overview-description">{project.description}</p>
        ) : null}
        <nav aria-label="プロジェクトセクション" className="project-overview-nav">
          <ul className="project-overview-link-list" data-testid="project-overview-link-list">
            <li>
              <Link
                data-testid="project-overview-reports-link"
                href={`/projects/${project.slug}/reports`}
              >
                Reportsを開く
              </Link>
            </li>
            <li>
              <Link
                data-testid="project-overview-chat-link"
                href={`/projects/${project.slug}/chat`}
              >
                Chatを開く
              </Link>
            </li>
          </ul>
        </nav>
      </section>
      {overviewResult.kind === 'ready' ? (
        <ProjectOverviewSection snapshot={overviewResult.snapshot} />
      ) : overviewResult.kind === 'error' ? (
        <ProjectOverviewErrorState />
      ) : (
        <ProjectOverviewEmptyState />
      )}
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
                <span>{formatReportSummaryPreview(report.summary)}</span>
                <small>{report.publishedAt}</small>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}

function isUnknownProjectError(error: unknown): boolean {
  return error instanceof ProjectNotFoundError;
}

async function loadProjectOverview(input: {
  readonly isMember: boolean;
  readonly projectSlug: string;
}) {
  try {
    const sql = getOptionalAdminSql();
    if (!sql) {
      return { kind: 'empty' as const };
    }
    const repository = createPostgresReportRepository(sql);
    const project = await repository.lookupProject({ projectSlug: input.projectSlug });
    if (!project) {
      return { kind: 'empty' as const };
    }
    return loadLatestProjectOverview({
      isMember: input.isMember,
      projectId: project.id,
      projectSlug: input.projectSlug,
      repository,
      storage: createReportStorageFromEnv(),
    });
  } catch {
    return { kind: 'error' as const };
  }
}
