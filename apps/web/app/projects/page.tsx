import Link from 'next/link';
import { listAdminProjects } from '../../src/admin-db';
import { AppShell, MetricStrip, PageHeader, StatusBadge } from '../../src/ui';

export default async function ProjectsPage() {
  const projects = await listAdminProjects();

  return (
    <AppShell active="projects">
      <PageHeader
        title="Projects"
        subtitle="プロジェクトごとの ingestion 状態と管理画面への入口を確認します。"
        action={
          <button className="primary-button" data-testid="project-create-button" type="button">
            Add Project
          </button>
        }
      />
      <section className="project-grid" data-testid="project-list">
        {projects.map((project) => (
          <article
            className="project-card"
            data-testid={`project-card-${project.slug}`}
            key={project.slug}
          >
            <div className="project-card-header">
              <div>
                <p className="eyebrow">{project.slug}</p>
                <h2>{project.name}</h2>
              </div>
              <StatusBadge status={project.status === 'active' ? 'healthy' : 'failed'} />
            </div>
            <MetricStrip project={project} />
            <dl className="detail-list">
              <div>
                <dt>Members</dt>
                <dd>{project.memberCount}</dd>
              </div>
              <div>
                <dt>Last indexed</dt>
                <dd>{project.lastIndexed}</dd>
              </div>
            </dl>
            <div className="action-row">
              <Link
                className="secondary-link"
                data-testid={`project-open-${project.slug}`}
                href={`/projects/${project.slug}/admin/data-sources`}
              >
                Data Sources
              </Link>
              <Link className="secondary-link" href={`/projects/${project.slug}/admin/ingestion`}>
                Ingestion
              </Link>
            </div>
          </article>
        ))}
      </section>
    </AppShell>
  );
}
