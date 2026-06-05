import { createDataSource, updateDataSource } from '../../../../../src/admin-actions';
import type { SourceType } from '../../../../../src/admin-data';
import { getAdminProject, getSourceTypeCounts } from '../../../../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import {
  AppShell,
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
  const activeSourceType = parseSourceType(sourceType);
  const project = await getAdminProject(projectSlug);
  const visibleSources = activeSourceType
    ? project.dataSources.filter((source) => source.sourceType === activeSourceType)
    : project.dataSources;
  const selectedSource =
    visibleSources.find((source) => source.id === dataSourceId) ?? visibleSources[0];
  const counts = getSourceTypeCounts(project);

  return (
    <AppShell active="data-sources" project={project}>
      <PageHeader
        title={`${project.name} Data Sources`}
        subtitle="収集対象、設定、queue の状態を source type ごとに確認します。"
      />
      <MetricStrip project={project} />
      <SourceTypeTabs activeType={activeSourceType} projectSlug={project.slug} />
      <details className="panel create-project-panel" data-testid="data-source-create-panel">
        <summary className="primary-button" data-testid="data-source-add-button">
          Add Source
        </summary>
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
              defaultValue={activeSourceType ?? 'web'}
              name="sourceType"
              required
            >
              <option value="web">Web</option>
              <option value="github">GitHub</option>
              <option value="drive">Drive</option>
              <option value="gmail">Gmail</option>
            </select>
          </label>
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
            title="Create data source"
          >
            Create Source
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
                <button
                  className="icon-button muted"
                  data-testid="data-source-run-button"
                  type="button"
                >
                  Collect
                </button>
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
