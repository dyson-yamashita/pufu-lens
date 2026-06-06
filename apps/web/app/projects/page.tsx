import Link from 'next/link';
import { createProject } from '../../src/admin-actions';
import { listAdminProjects, listPublicProjects } from '../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../src/form-buttons';
import { AppShell, MetricStrip, PageHeader, StatusBadge } from '../../src/ui';

export default async function ProjectsPage() {
  const [projects, publicProjects] = await Promise.all([listAdminProjects(), listPublicProjects()]);
  const canCreateProject = process.env.PUFU_LENS_ENABLE_PROJECT_CREATE_UI === 'true';

  return (
    <AppShell active="projects">
      <PageHeader
        title="Projects"
        subtitle="プロジェクトごとの ingestion 状態と管理画面への入口を確認します。"
      />
      {canCreateProject ? (
        <details className="panel create-project-panel" data-testid="project-create-panel">
          <summary className="primary-button" data-testid="project-create-button">
            Add Project
          </summary>
          <ActionForm action={createProject} className="project-create-form">
            <label>
              <span>Name</span>
              <input data-testid="project-name-input" name="name" required type="text" />
            </label>
            <label>
              <span>Slug</span>
              <input
                data-testid="project-slug-input"
                name="slug"
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                placeholder="project-alpha"
                required
                type="text"
              />
            </label>
            <label className="project-create-description">
              <span>Description</span>
              <textarea data-testid="project-description-input" name="description" rows={2} />
            </label>
            <PendingSubmitButton
              className="primary-button"
              testId="project-submit-button"
              title="Create project"
            >
              Create Project
            </PendingSubmitButton>
          </ActionForm>
        </details>
      ) : null}
      <section className="panel" data-testid="public-project-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Public</p>
            <h2>Public Projects</h2>
          </div>
        </div>
        {publicProjects.length > 0 ? (
          <div className="project-grid compact">
            {publicProjects.map((project) => (
              <article
                className="project-card"
                data-testid={`public-project-${project.slug}`}
                key={project.slug}
              >
                <div className="project-card-header">
                  <div>
                    <p className="eyebrow">{project.slug}</p>
                    <h3>{project.name}</h3>
                  </div>
                  <StatusBadge status="healthy" />
                </div>
                <p>{project.description}</p>
                <div className="source-list">
                  {project.reports.map((report) => (
                    <Link
                      className="source-chip"
                      data-testid={`public-report-${project.slug}-${report.id}`}
                      href={`/reports/public/${project.slug}/${report.id}`}
                      key={report.id}
                    >
                      <strong>{report.title}</strong>
                      <span>{report.summary}</span>
                      <small>{report.publishedAt}</small>
                    </Link>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="notice" data-testid="public-project-empty">
            public project はまだありません。
          </p>
        )}
      </section>
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
