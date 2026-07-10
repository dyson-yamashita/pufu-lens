import Link from 'next/link';
import {
  collectAndIngestDataSource,
  createDataSource,
  deleteDataSource,
  retryFailedQueue,
  updateDataSource,
  updateDataSourceSchedule,
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
import { getDataSourceSchedule } from '../../../../../src/admin-source-schedule-actions.ts';
import { DataSourceDetailDialog } from '../../../../../src/data-source-detail-dialog';
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
  const selectedSource = dataSourceId
    ? visibleSources.find((source) => source.id === dataSourceId)
    : undefined;
  const selectedSourceAvailable = selectedSource ? availability[selectedSource.sourceType] : true;
  const counts = getSourceTypeCounts(project);
  let contentPreview = null;
  let schedule = null;
  if (selectedSource) {
    try {
      contentPreview = await getDataSourceContentPreview(projectSlug, selectedSource.id);
    } catch (error) {
      console.error('Failed to load data source content preview:', error);
    }
    try {
      schedule = await getDataSourceSchedule(projectSlug, selectedSource.id);
    } catch (error) {
      console.error('Failed to load data source schedule:', error);
    }
  }

  return (
    <AppShell active="data-sources" canManageProject project={project}>
      <PageHeader
        title={`${project.name} Data Sources`}
        subtitle="収集対象、設定、queue の状態を source type ごとに確認します。"
      />
      <MetricStrip project={project} />
      <section className="panel create-project-panel" data-testid="data-source-create-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Source</p>
            <h2>Add Source</h2>
          </div>
        </div>
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
          <label className="project-create-description">
            <span>Scope</span>
            <textarea
              data-testid="data-source-scope-input"
              name="scope"
              placeholder="URL, owner/repo, Drive folder id, or Gmail query"
              required
              rows={1}
            />
          </label>
          <PendingSubmitButton
            className="primary-button"
            testId="data-source-submit-button"
            title="Create data source and run collect"
          >
            Create & Collect
          </PendingSubmitButton>
          {requestedSourceType && !availability[requestedSourceType] ? (
            <p
              className="connection-required-notice project-create-notice"
              data-testid={`data-source-connection-notice-${requestedSourceType}`}
            >
              {sourceTypeLabel(requestedSourceType)} の作成には Settings での接続が必要です。{' '}
              <Link href={connectionStartHref(project.slug, requestedSourceType)}>接続を開始</Link>
            </p>
          ) : null}
          {!availability.github || !availability.gmail || !availability.drive ? (
            <p
              className="connection-required-notice project-create-notice"
              data-testid="data-source-connection-notice"
            >
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
        </ActionForm>
      </section>
      <SourceTypeTabs
        activeType={activeSourceType}
        availability={availability}
        projectSlug={project.slug}
      />
      <section>
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
            collectAndIngestAction={collectAndIngestDataSource}
            canCollectAndIngest={(source) =>
              isAdminUiCollectionSupported(source.sourceType) &&
              isAdminUiIngestSupported(source.sourceType) &&
              availability[source.sourceType]
            }
            projectSlug={project.slug}
            retryAction={retryFailedQueue}
            sources={visibleSources}
          />
        </div>
        {selectedSource ? (
          <DataSourceDetailDialog
            closeHref={dataSourceListHref(project.slug, activeSourceType)}
            key={selectedSource.id}
          >
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
                {!selectedSourceAvailable ? (
                  <p
                    className="connection-required-notice"
                    data-testid="data-source-selected-connection-notice"
                  >
                    {sourceTypeLabel(selectedSource.sourceType)} の connection
                    を利用できません。Name / Scope の保存は可能ですが、Collect は Settings
                    で接続状態を確認するまで実行できません。{' '}
                    <Link href={connectionStartHref(project.slug, selectedSource.sourceType)}>
                      接続を確認
                    </Link>
                  </p>
                ) : null}
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
                      rows={1}
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
                {selectedSource.sourceType === 'web' ? (
                  <section
                    className="schedule-settings"
                    data-testid="data-source-schedule-unavailable"
                  >
                    <h3 className="data-source-section-title">Schedule</h3>
                    <p className="content-preview-empty">
                      Web source は自動実行せず、Collect &amp; Ingest から手動で差分を取り込みます。
                    </p>
                  </section>
                ) : schedule ? (
                  <ActionForm
                    action={updateDataSourceSchedule}
                    className="detail-edit-form schedule-settings"
                    testId="data-source-schedule-form"
                  >
                    <input name="projectSlug" type="hidden" value={project.slug} />
                    <input name="dataSourceId" type="hidden" value={selectedSource.id} />
                    <h3 className="data-source-section-title">Schedule</h3>
                    <label>
                      <span>Automatic sync</span>
                      <input
                        data-testid="data-source-schedule-enabled"
                        defaultChecked={schedule.enabled}
                        name="enabled"
                        type="checkbox"
                      />
                    </label>
                    <label>
                      <span>Daily time ({schedule.timezone})</span>
                      <input
                        data-testid="data-source-schedule-time"
                        defaultValue={schedule.dailyTime}
                        name="dailyTime"
                        required
                        type="time"
                      />
                    </label>
                    <dl className="detail-list stacked">
                      <div>
                        <dt>Next run</dt>
                        <dd>{formatScheduleTimestamp(schedule.nextRunAt)}</dd>
                      </div>
                      <div>
                        <dt>Last success</dt>
                        <dd>{formatScheduleTimestamp(schedule.lastSucceededAt)}</dd>
                      </div>
                      <div>
                        <dt>Last failure</dt>
                        <dd>{formatScheduleTimestamp(schedule.lastFailedAt)}</dd>
                      </div>
                      <div>
                        <dt>Retry count</dt>
                        <dd>{schedule.retryCount}</dd>
                      </div>
                    </dl>
                    <div className="action-row">
                      <PendingSubmitButton
                        className="icon-button"
                        testId="data-source-schedule-save-button"
                        title="Save schedule"
                      >
                        Save schedule
                      </PendingSubmitButton>
                    </div>
                  </ActionForm>
                ) : (
                  <p className="content-preview-empty" data-testid="data-source-schedule-missing">
                    Schedule を読み込めませんでした。
                  </p>
                )}
                <div className="action-row">
                  <ActionForm action={collectAndIngestDataSource} className="inline-action-form">
                    <input name="projectSlug" type="hidden" value={project.slug} />
                    <input name="dataSourceId" type="hidden" value={selectedSource.id} />
                    <PendingSubmitButton
                      className="icon-button muted"
                      disabled={
                        !selectedSourceAvailable ||
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
                <ActionForm
                  action={deleteDataSource}
                  className="inline-action-form data-source-delete-form"
                  confirmMessage={`Delete "${selectedSource.name}"? Exclusive ingest data for this data source will be removed. Documents shared with other data sources will keep their content.`}
                  testId="data-source-delete-form"
                >
                  <input name="projectSlug" type="hidden" value={project.slug} />
                  <input name="dataSourceId" type="hidden" value={selectedSource.id} />
                  <PendingSubmitButton
                    className="icon-button danger-button"
                    pendingLabel="Deleting"
                    testId="data-source-delete-button"
                    title="Delete data source"
                  >
                    Delete
                  </PendingSubmitButton>
                </ActionForm>
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
          </DataSourceDetailDialog>
        ) : null}
      </section>
    </AppShell>
  );
}

function formatScheduleTimestamp(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(value));
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

function dataSourceListHref(projectSlug: string, activeType: SourceType | undefined): string {
  const params = new URLSearchParams();
  if (activeType) {
    params.set('sourceType', activeType);
  }
  const query = params.toString();
  return `/projects/${projectSlug}/admin/data-sources${query ? `?${query}` : ''}`;
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
