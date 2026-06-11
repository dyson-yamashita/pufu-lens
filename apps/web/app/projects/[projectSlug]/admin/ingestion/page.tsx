import {
  collectDataSource,
  ingestDataSource,
  retryFailedQueue,
} from '../../../../../src/admin-actions';
import {
  isAdminUiCollectionSupported,
  isAdminUiIngestSupported,
} from '../../../../../src/admin-data';
import { getAdminProject } from '../../../../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import { AppShell, MetricStrip, PageHeader, RetryButton, StatusBadge } from '../../../../../src/ui';

export default async function IngestionPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await getAdminProject(projectSlug);

  return (
    <AppShell active="ingestion" project={project}>
      <PageHeader
        title={`${project.name} Ingestion`}
        subtitle="raw document、queue、failed、held の状態をプロジェクト単位で確認します。"
        action={
          <RetryButton
            action={retryFailedQueue}
            projectSlug={project.slug}
            testId="ingestion-retry-failed-button"
          />
        }
      />
      <MetricStrip project={project} />
      <section className="panel">
        <div className="panel-heading">
          <h2>Queue Status</h2>
          <span className="mono">Last indexed {project.lastIndexed}</span>
        </div>
        <div className="status-list" data-testid="ingestion-status-list">
          {project.dataSources.map((source) => (
            <article
              className="status-row"
              data-testid={`ingestion-source-${source.id}`}
              key={source.id}
            >
              <div>
                <h3>{source.name}</h3>
                <p>{source.scope}</p>
              </div>
              <StatusBadge status={source.status} />
              <div className="queue-numbers">
                <span>
                  <strong>{source.rawCount}</strong>
                  raw
                </span>
                <span>
                  <strong>{source.queueCount}</strong>
                  queue
                </span>
                <span>
                  <strong>{source.failedCount}</strong>
                  failed
                </span>
                <span>
                  <strong>{source.heldCount}</strong>
                  held
                </span>
              </div>
              <RetryButton
                action={retryFailedQueue}
                dataSourceId={source.id}
                projectSlug={project.slug}
                testId={`ingestion-retry-${source.id}`}
              />
              <ActionForm action={collectDataSource} className="inline-action-form">
                <input name="projectSlug" type="hidden" value={project.slug} />
                <input name="dataSourceId" type="hidden" value={source.id} />
                <PendingSubmitButton
                  className="icon-button"
                  disabled={!isAdminUiCollectionSupported(source.sourceType)}
                  testId={`ingestion-collect-${source.id}`}
                  title="Collect source"
                >
                  Collect
                </PendingSubmitButton>
              </ActionForm>
              <ActionForm action={ingestDataSource} className="inline-action-form">
                <input name="projectSlug" type="hidden" value={project.slug} />
                <input name="dataSourceId" type="hidden" value={source.id} />
                <PendingSubmitButton
                  className="icon-button"
                  disabled={!isAdminUiIngestSupported(source.sourceType)}
                  testId={`ingestion-ingest-${source.id}`}
                  title="Ingest source"
                >
                  Ingest
                </PendingSubmitButton>
              </ActionForm>
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
