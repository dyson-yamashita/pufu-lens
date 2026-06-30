import Link from 'next/link';
import {
  deleteProject,
  updateGithubAppConnectionSettings,
  updateProjectSettings,
} from '../../../../../src/admin-actions';
import type { ConnectionProvider, ProjectConnectionStatus } from '../../../../../src/admin-data';
import { listProjectConnections } from '../../../../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import { ProjectDeleteDialog } from '../../../../../src/project-delete-dialog';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import { AppShell, PageHeader, StatusBadge } from '../../../../../src/ui';

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
  readonly searchParams?: Promise<{
    readonly connectionError?: string;
    readonly connectionStatus?: string;
  }>;
}) {
  const { projectSlug } = await params;
  const connectionParams = await searchParams;
  const project = await requireProjectAdminPage(projectSlug);
  const connections = await listProjectConnections(projectSlug);

  return (
    <AppShell active="settings" canManageProject project={project}>
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
      <section className="panel connections-panel" data-testid="project-settings-connections-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Integrations</p>
            <h2>Connections</h2>
          </div>
        </div>
        {connectionParams?.connectionStatus ? (
          <p className="notice" data-testid="connection-status-notice">
            Connection updated.
          </p>
        ) : null}
        {connectionParams?.connectionError ? (
          <p className="notice error" data-testid="connection-error-notice">
            Connection setup could not start or complete. Check provider environment settings.
          </p>
        ) : null}
        <p className="connections-panel-copy">
          このプロジェクトの Gmail / Drive / GitHub 収集に使う連携です。Google は source type
          追加時に必要な scope を追加要求し、GitHub は GitHub App installation として接続します。
        </p>
        <div className="connection-card-grid">
          {connections.map((connection) => (
            <article
              className="connection-card"
              data-testid={`connection-${connection.provider}-card`}
              key={connection.provider}
            >
              <div className="connection-card-header">
                <div>
                  <p className="eyebrow">{connection.provider}</p>
                  <h3>{connection.provider === 'google' ? 'Google' : 'GitHub'}</h3>
                </div>
                <span
                  className={`status-badge status-connection-${connection.status}`}
                  data-testid={`connection-${connection.provider}-status`}
                >
                  {connectionStatusLabel(connection.status)}
                </span>
              </div>
              <dl className="detail-list stacked connection-detail-list">
                <div>
                  <dt>Account</dt>
                  <dd>{connection.accountLabel ?? 'Not connected'}</dd>
                </div>
                <div>
                  <dt>Scopes</dt>
                  <dd>{connection.scopesSummary}</dd>
                </div>
                <div>
                  <dt>Permissions</dt>
                  <dd>{connection.permissionsSummary}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{connection.updatedAt}</dd>
                </div>
                {connection.metadataLabels.length > 0 ? (
                  <div>
                    <dt>Metadata</dt>
                    <dd>
                      <ul className="connection-metadata-list">
                        {connection.metadataLabels.map((label) => (
                          <li key={label}>{label}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {connection.status !== 'connected' ? (
                <p
                  className="connection-required-notice"
                  data-testid={`connection-${connection.provider}-operation-notice`}
                >
                  {connectionOperationNotice(connection.provider, connection.status)}
                </p>
              ) : null}
              <div className="action-row">
                <Link
                  className="primary-button"
                  data-testid={`connection-${connection.provider}-connect-button`}
                  href={`/api/connections/${connection.provider}/start?projectSlug=${encodeURIComponent(project.slug)}`}
                >
                  {connection.status === 'connected'
                    ? connection.provider === 'github'
                      ? 'Reconfigure'
                      : 'Reconnect'
                    : connection.provider === 'github'
                      ? 'Install'
                      : 'Connect'}
                </Link>
                {connection.provider === 'google' ? (
                  <>
                    <Link
                      className="icon-button"
                      data-testid="connection-google-drive-connect-button"
                      href={`/api/connections/google/start?${new URLSearchParams({
                        projectSlug: project.slug,
                        sourceType: 'drive',
                      }).toString()}`}
                    >
                      {connection.grantedScopes.includes(
                        'https://www.googleapis.com/auth/drive.readonly',
                      )
                        ? 'Drive connected'
                        : 'Connect Drive'}
                    </Link>
                    <Link
                      className="icon-button"
                      data-testid="connection-google-gmail-connect-button"
                      href={`/api/connections/google/start?${new URLSearchParams({
                        projectSlug: project.slug,
                        sourceType: 'gmail',
                      }).toString()}`}
                    >
                      {connection.grantedScopes.includes(
                        'https://www.googleapis.com/auth/gmail.readonly',
                      )
                        ? 'Gmail connected'
                        : 'Connect Gmail'}
                    </Link>
                  </>
                ) : null}
              </div>
              {connection.provider === 'github' ? (
                <ActionForm
                  action={updateGithubAppConnectionSettings}
                  className="detail-edit-form connection-config-form"
                  testId="connection-github-app-config-form"
                >
                  <input name="projectSlug" type="hidden" value={project.slug} />
                  <label>
                    <span>App slug</span>
                    <input
                      data-testid="connection-github-app-slug-input"
                      defaultValue={connection.configuration.githubAppSlug ?? ''}
                      name="githubAppSlug"
                      required
                      type="text"
                    />
                  </label>
                  <label>
                    <span>App ID</span>
                    <input
                      data-testid="connection-github-app-id-input"
                      defaultValue={connection.configuration.githubAppId ?? ''}
                      inputMode="numeric"
                      name="githubAppId"
                      required
                      type="text"
                    />
                  </label>
                  <label>
                    <span>Private key</span>
                    <textarea
                      autoComplete="off"
                      data-testid="connection-github-private-key-input"
                      name="githubAppPrivateKey"
                      placeholder={
                        connection.configuration.githubPrivateKeyConfigured
                          ? 'Paste a new PEM private key to replace the saved key'
                          : 'Paste the GitHub App PEM private key'
                      }
                      required={!connection.configuration.githubPrivateKeyConfigured}
                      rows={6}
                    />
                  </label>
                  <div className="action-row">
                    <PendingSubmitButton
                      className="icon-button"
                      testId="connection-github-app-config-save-button"
                      title="Save GitHub App settings"
                    >
                      Save GitHub App
                    </PendingSubmitButton>
                  </div>
                </ActionForm>
              ) : null}
            </article>
          ))}
        </div>
      </section>
      <section className="panel danger-zone-panel" data-testid="project-settings-danger-zone">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Danger zone</p>
            <h2>Delete project</h2>
          </div>
        </div>
        <p className="danger-zone-copy">
          プロジェクトを完全に削除します。メンバー、連携、データソース、グラフ、レポートなど関連データも削除され、元に戻せません。
        </p>
        <ProjectDeleteDialog
          action={deleteProject}
          projectName={project.name}
          projectSlug={project.slug}
        />
      </section>
    </AppShell>
  );
}

function connectionStatusLabel(status: ProjectConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'expired':
      return 'Expired';
    case 'scope_missing':
      return 'Scope missing';
    case 'error':
      return 'Error';
    default:
      return 'Not connected';
  }
}

function connectionOperationNotice(
  provider: ConnectionProvider,
  status: ProjectConnectionStatus,
): string {
  const providerLabel = provider === 'google' ? 'Google' : 'GitHub';
  switch (status) {
    case 'connected':
      return '';
    case 'expired':
      return `${providerLabel} 連携が失効しています。再接続するまで、この provider を使う data source の作成・保存・収集は停止します。`;
    case 'scope_missing':
      return `${providerLabel} 連携の scope が不足しています。必要な scope を追加するまで、対象 data source は選択・実行できません。`;
    case 'error':
      return `${providerLabel} 連携の設定にエラーがあります。provider 側の設定を確認してから再接続してください。`;
    default:
      return `${providerLabel} 連携が未設定です。接続後に対象 data source を作成・実行できます。`;
  }
}
