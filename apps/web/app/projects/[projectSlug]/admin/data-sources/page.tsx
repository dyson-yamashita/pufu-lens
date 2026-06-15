import Link from 'next/link';
import {
  collectAndIngestDataSource,
  createDataSource,
  updateDataSource,
} from '../../../../../src/admin-actions';
import {
  isAdminUiCollectionSupported,
  isAdminUiIngestSupported,
  type SourceType,
} from '../../../../../src/admin-data';
import {
  getDataSourceContentPreview,
  getProjectSourceAvailability,
  getSourceTypeCounts,
} from '../../../../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import {
  AppShell,
  DataSourceContentPreviewPanel,
  DataSourceQueuePreviewPanel,
  DataSourceTable,
  MetricStrip,
  PageHeader,
  SourceTypeTabs,
  StatusBadge,
} from '../../../../../src/ui';

export default async function DataSourcesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
  readonly searchParams: Promise<{ readonly dataSourceId?: string; readonly sourceType?: string }>;
}) {
  const { projectSlug } = await params;
  const { dataSourceId, sourceType } = await searchParams;
  const project = await requireProjectAdminPage(projectSlug);
  const requestedSourceType = parseSourceType(sourceType);
  const availability = await getProjectSourceAvailability(projectSlug);
  const activeSourceType =
    requestedSourceType && availability[requestedSourceType] ? requestedSourceType : undefined;
  const defaultSourceType = resolveDefaultSourceType(activeSourceType, availability);
  const visibleSources = activeSourceType
    ? project.dataSources.filter((source) => source.sourceType === activeSourceType)
    : project.dataSources;
  const selectedSource =
    visibleSources.find((source) => source.id === dataSourceId) ?? visibleSources[0];
  const counts = getSourceTypeCounts(project);
  const contentPreview = selectedSource
    ? await getDataSourceContentPreview(projectSlug, selectedSource.id)
    : null;

  return (
    <AppShell active="data-sources" canManageProject project={project}>
      <PageHeader
        title={`${project.name} Data Sources`}
        subtitle="収集対象、設定、queue の状態を source type ごとに確認します。"
      />
      <MetricStrip project={project} />
      <SourceTypeTabs
        activeType={activeSourceType}
        availability={availability}
        projectSlug={project.slug}
      />
      <details className="panel create-project-panel" data-testid="data-source-create-panel">
        <summary className="primary-button" data-testid="data-source-add-button">
          Add Source
        </summary>
        {requestedSourceType && !availability[requestedSourceType] ? (
          <p
            className="connection-required-notice"
            data-testid={`data-source-connection-notice-${requestedSourceType}`}
          >
            {sourceTypeLabel(requestedSourceType)} の作成には Settings での接続が必要です。{' '}
            <Link href={connectionStartHref(project.slug, requestedSourceType)}>接続を開始</Link>
          </p>
        ) : null}
        <ActionForm action={createDataSource} className="project-create-form">
          <input name="projectSlug" type="hidden" value={project.slug} />
          <label>
            <span>Name</span>
            <input data-testid="data-source-name-input" name="name" required type="text" />
          </label>
          <label>
            <span>Type</span>
            <select
              data-testid="data-source-type-input"
              defaultValue={defaultSourceType}
              name="sourceType"
              required
            >
              <DataSourceTypeOption availability={availability} label="Web" sourceType="web" />
              <DataSourceTypeOption
                availability={availability}
                label="GitHub"
                sourceType="github"
              />
              <DataSourceTypeOption availability={availability} label="Drive" sourceType="drive" />
              <DataSourceTypeOption availability={availability} label="Gmail" sourceType="gmail" />
            </select>
          </label>
          {!availability.github || !availability.gmail || !availability.drive ? (
            <p className="connection-required-notice" data-testid="data-source-connection-notice">
              未接続または scope 不足の provider があるため、一部の source type は選択できません。{' '}
              {!availability.drive ? (
                <>
                  <Link href={connectionStartHref(project.slug, 'drive')}>Drive を接続</Link>{' '}
                </>
              ) : null}
              {!availability.gmail ? (
                <>
                  <Link href={connectionStartHref(project.slug, 'gmail')}>Gmail を接続</Link>{' '}
                </>
              ) : null}
              {!availability.github ? (
                <Link href={connectionStartHref(project.slug, 'github')}>GitHub を接続</Link>
              ) : null}
            </p>
          ) : null}
          <label className="project-create-description">
            <span>Scope</span>
            <textarea
              data-testid="data-source-scope-input"
              name="scope"
              placeholder="URL, owner/repo, Drive folder id, or Gmail query"
              required
              rows={2}
            />
          </label>
          <PendingSubmitButton
            className="primary-button"
            testId="data-source-submit-button"
            title="Create data source and run collect and ingest"
          >
            Create, Collect & Ingest
          </PendingSubmitButton>
        </ActionForm>
      </details>
      <section className="split-layout">
        <div className="panel">
          <div className="panel-heading">
            <h2>Source List</h2>
            <span className="mono">
              web {counts.web} / github {counts.github}
            </span>
          </div>
          <DataSourceTable
            activeSourceId={selectedSource?.id}
            activeType={activeSourceType}
            projectSlug={project.slug}
            sources={visibleSources}
          />
        </div>
        <aside className="panel" data-testid="data-source-detail-panel">
          {selectedSource ? (
            <>
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{selectedSource.sourceType}</p>
                  <h2>{selectedSource.name}</h2>
                </div>
                <StatusBadge status={selectedSource.status} />
              </div>
              <div className="data-source-detail-sections">
                <section
                  className="data-source-detail-section"
                  data-testid="data-source-settings-section"
                >
                  <h3 className="data-source-section-title">Settings</h3>
                  <ActionForm action={updateDataSource} className="detail-edit-form">
                    <input name="projectSlug" type="hidden" value={project.slug} />
                    <input name="dataSourceId" type="hidden" value={selectedSource.id} />
                    <label>
                      <span>Name</span>
                      <input
                        data-testid="data-source-edit-name-input"
                        defaultValue={selectedSource.name}
                        name="name"
                        required
                        type="text"
                      />
                    </label>
                    <label>
                      <span>Scope</span>
                      <textarea
                        data-testid="data-source-edit-scope-input"
                        defaultValue={selectedSource.editableScope}
                        name="scope"
                        required
                        rows={3}
                      />
                    </label>
                    <dl className="detail-list stacked">
                      <div>
                        <dt>Current scope</dt>
                        <dd>{selectedSource.scope}</dd>
                      </div>
                      <div>
                        <dt>Config</dt>
                        <dd>{selectedSource.configSummary}</dd>
                      </div>
                      <div>
                        <dt>Last run</dt>
                        <dd>{selectedSource.lastChecked}</dd>
                      </div>
                      <div>
                        <dt>Last indexed</dt>
                        <dd>{selectedSource.lastIndexed}</dd>
                      </div>
                    </dl>
                    <div className="action-row">
                      <PendingSubmitButton
                        className="icon-button"
                        testId="data-source-save-button"
                        title="Save data source"
                      >
                        Save
                      </PendingSubmitButton>
                    </div>
                  </ActionForm>
                  <div className="action-row">
                    <button
                      className="icon-button muted"
                      data-testid="data-source-test-button"
                      type="button"
                    >
                      Test
                    </button>
                    <ActionForm action={collectAndIngestDataSource} className="inline-action-form">
                      <input name="projectSlug" type="hidden" value={project.slug} />
                      <input name="dataSourceId" type="hidden" value={selectedSource.id} />
                      <PendingSubmitButton
                        className="icon-button muted"
                        disabled={
                          !isAdminUiCollectionSupported(selectedSource.sourceType) ||
                          !isAdminUiIngestSupported(selectedSource.sourceType)
                        }
                        pendingLabel="Running"
                        testId="data-source-run-button"
                        title="Collect and ingest data source"
                      >
                        Collect & Ingest
                      </PendingSubmitButton>
                    </ActionForm>
                  </div>
                </section>
                {contentPreview ? (
                  <>
                    <DataSourceContentPreviewPanel preview={contentPreview} />
                    <DataSourceQueuePreviewPanel preview={contentPreview} />
                  </>
                ) : (
                  <section
                    className="data-source-detail-section"
                    data-testid="data-source-content-panel"
                  >
                    <h3 className="data-source-section-title">Content</h3>
                    <p className="content-preview-empty" data-testid="data-source-content-empty">
                      プレビューを読み込めませんでした。
                    </p>
                  </section>
                )}
              </div>
            </>
          ) : null}
        </aside>
      </section>
    </AppShell>
  );
}

function parseSourceType(value: string | undefined): SourceType | undefined {
  if (value === 'drive' || value === 'github' || value === 'gmail' || value === 'web') {
    return value;
  }
  return undefined;
}

function resolveDefaultSourceType(
  activeSourceType: SourceType | undefined,
  availability: Record<SourceType, boolean>,
): SourceType {
  if (activeSourceType && availability[activeSourceType]) {
    return activeSourceType;
  }
  return 'web';
}

function sourceTypeLabel(sourceType: SourceType): string {
  switch (sourceType) {
    case 'github':
      return 'GitHub';
    case 'drive':
      return 'Drive';
    case 'gmail':
      return 'Gmail';
    default:
      return 'Web';
  }
}

function connectionStartHref(projectSlug: string, sourceType: SourceType): string {
  const provider = sourceType === 'github' ? 'github' : 'google';
  const params = new URLSearchParams({ projectSlug });
  if (sourceType === 'drive' || sourceType === 'gmail') {
    params.set('sourceType', sourceType);
  }
  return `/api/connections/${provider}/start?${params.toString()}`;
}

function DataSourceTypeOption({
  availability,
  label,
  sourceType,
}: {
  readonly availability: Record<SourceType, boolean>;
  readonly label: string;
  readonly sourceType: SourceType;
}) {
  const enabled = availability[sourceType];
  return (
    <option
      data-testid={
        enabled
          ? `data-source-type-option-${sourceType}`
          : `data-source-type-option-${sourceType}-disabled`
      }
      disabled={!enabled}
      value={sourceType}
    >
      {label}
      {!enabled ? ' (connection required)' : ''}
    </option>
  );
}
