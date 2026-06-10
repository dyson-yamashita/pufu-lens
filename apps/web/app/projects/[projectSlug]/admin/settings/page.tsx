import { redirect } from 'next/navigation';
import { updateProjectSettings } from '../../../../../src/admin-actions';
import { getProjectMembership } from '../../../../../src/admin-db';
import { getSessionUserId } from '../../../../../src/auth-session';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import { AppShell, PageHeader, StatusBadge } from '../../../../../src/ui';

export default async function ProjectSettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const userId = await getSessionUserId();
  if (!userId) {
    redirect('/login');
  }

  let membership: Awaited<ReturnType<typeof getProjectMembership>>;
  try {
    membership = await getProjectMembership(projectSlug, userId);
  } catch {
    redirect('/projects');
  }
  if (!membership.canManageMembers) {
    redirect(`/projects/${projectSlug}`);
  }
  const project = membership.project;

  return (
    <AppShell active="settings" project={project}>
      <PageHeader
        title={`${project.name} Settings`}
        subtitle="プロジェクトの基本情報と公開範囲を管理します。"
      />
      <section className="panel" data-testid="project-settings-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{project.slug}</p>
            <h2>Project Settings</h2>
          </div>
          <span
            className={`status-badge status-visibility-${project.visibility}`}
            data-testid={`project-settings-visibility-${project.slug}`}
          >
            {project.visibility}
          </span>
        </div>
        <dl className="detail-list stacked">
          <div>
            <dt>Slug</dt>
            <dd className="mono">{project.slug}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={project.status === 'active' ? 'healthy' : 'failed'} />
            </dd>
          </div>
        </dl>
        <ActionForm
          action={updateProjectSettings}
          className="detail-edit-form"
          testId="project-settings-form"
        >
          <input name="projectSlug" type="hidden" value={project.slug} />
          <label>
            <span>Name</span>
            <input
              data-testid="project-settings-name-input"
              defaultValue={project.name}
              name="name"
              required
              type="text"
            />
          </label>
          <label>
            <span>Description</span>
            <textarea
              data-testid="project-settings-description-input"
              defaultValue={project.description ?? ''}
              name="description"
              rows={4}
            />
          </label>
          <label>
            <span>Visibility</span>
            <select
              data-testid="project-settings-visibility-select"
              defaultValue={project.visibility}
              name="visibility"
            >
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          </label>
          <div className="action-row">
            <PendingSubmitButton
              className="primary-button"
              testId="project-settings-save-button"
              title="Save project settings"
            >
              Save settings
            </PendingSubmitButton>
          </div>
        </ActionForm>
      </section>
    </AppShell>
  );
}
