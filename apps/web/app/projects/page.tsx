import Link from 'next/link';
import { auth } from '../../auth';
import { createProject } from '../../src/admin-actions';
import { filterPublicProjectsExcludingMemberProjects } from '../../src/admin-data';
import {
  listAdminProjects,
  listMemberProjects,
  listVisiblePublicProjects,
} from '../../src/admin-db';
import { ProjectCreateDialog } from '../../src/project-create-dialog';
import { isDevelopmentBypassEnabled } from '../../src/runtime-guards';
import { AppShell, PageHeader, StatusBadge } from '../../src/ui';

export default async function ProjectsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  const isAdmin = session?.user?.role === 'admin';
  const canShowAdminProjects = isDevelopmentBypassEnabled('PUFU_LENS_ENABLE_ADMIN_PROJECT_LIST');
  const canCreateProject = isAdmin;
  const [projects, publicProjects] = await Promise.all([
    userId
      ? listMemberProjects(userId)
      : canShowAdminProjects
        ? listAdminProjects()
        : Promise.resolve([]),
    listVisiblePublicProjects(),
  ]);
  const discoveryPublicProjects = userId
    ? filterPublicProjectsExcludingMemberProjects(publicProjects, projects)
    : publicProjects;

  return (
    <AppShell active="projects">
      <PageHeader
        title="Projects"
        subtitle="プロジェクトごとの状態を確認し、カードからレポート一覧を開きます。"
      />
      {canCreateProject ? (
        <div className="create-project-panel" data-testid="project-create-panel">
          <ProjectCreateDialog action={createProject} />
        </div>
      ) : null}
      <div className="section-heading project-section-heading">
        <div>
          <h2>Public Projects</h2>
        </div>
      </div>
      <section className="project-grid" data-testid="public-project-list">
        {discoveryPublicProjects.length > 0 ? (
          discoveryPublicProjects.map((project) => (
            <article
              className="project-card project-card-link"
              data-testid={`public-project-${project.slug}`}
              key={project.slug}
            >
              <div className="project-card-header">
                <div>
                  <p className="eyebrow">{project.slug}</p>
                  <h2>{project.name}</h2>
                </div>
                <div className="status-stack">
                  <StatusBadge status="healthy" />
                  <span
                    className="status-badge status-visibility-public"
                    data-testid={`public-project-visibility-${project.slug}`}
                  >
                    public
                  </span>
                </div>
              </div>
              <p>{project.description}</p>
              <Link
                aria-label={`${project.name} を開く`}
                className="project-card-stretched-link"
                data-testid={`public-project-open-${project.slug}`}
                href={`/projects/${project.slug}`}
              />
            </article>
          ))
        ) : (
          <p className="notice" data-testid="public-project-empty">
            public project はまだありません。
          </p>
        )}
      </section>
      {userId ? (
        <>
          <div className="section-heading project-section-heading">
            <div>
              <h2>Your Projects</h2>
            </div>
          </div>
          <section className="project-grid" data-testid="project-list">
            {projects.length > 0 ? (
              projects.map((project) => (
                <article
                  className="project-card project-card-link"
                  data-testid={`project-card-${project.slug}`}
                  key={project.slug}
                >
                  <div className="project-card-header">
                    <div>
                      <p className="eyebrow">{project.slug}</p>
                      <h2>{project.name}</h2>
                    </div>
                    <div className="status-stack">
                      <StatusBadge status={project.status === 'active' ? 'healthy' : 'failed'} />
                      <span
                        className={`status-badge status-visibility-${project.visibility}`}
                        data-testid={`project-visibility-${project.slug}`}
                      >
                        {project.visibility}
                      </span>
                    </div>
                  </div>
                  {project.description ? <p>{project.description}</p> : null}
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
                  <Link
                    aria-label={`${project.name} のレポート一覧`}
                    className="project-card-stretched-link"
                    data-testid={`project-reports-link-${project.slug}`}
                    href={`/projects/${project.slug}`}
                  />
                </article>
              ))
            ) : (
              <p className="notice" data-testid="member-project-empty">
                参加している project はまだありません。
              </p>
            )}
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
