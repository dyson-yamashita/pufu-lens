import { getAdminProject, getSourceTypeCounts } from '../../../../../src/admin-db';
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
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await getAdminProject(projectSlug);
  const selectedSource = project.dataSources[0];
  const counts = getSourceTypeCounts(project);

  return (
    <AppShell active="data-sources" project={project}>
      <PageHeader
        title={`${project.name} Data Sources`}
        subtitle="収集対象、設定、queue の状態を source type ごとに確認します。"
        action={
          <button className="primary-button" data-testid="data-source-add-button" type="button">
            Add Source
          </button>
        }
      />
      <MetricStrip project={project} />
      <SourceTypeTabs />
      <section className="split-layout">
        <div className="panel">
          <div className="panel-heading">
            <h2>Source List</h2>
            <span className="mono">
              web {counts.web} / github {counts.github}
            </span>
          </div>
          <DataSourceTable sources={project.dataSources} />
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
              <dl className="detail-list stacked">
                <div>
                  <dt>Scope</dt>
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
                <button className="icon-button" data-testid="data-source-save-button" type="button">
                  Save
                </button>
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
