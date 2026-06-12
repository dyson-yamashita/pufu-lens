import { Clock3 } from 'lucide-react';
import { collectAndIngestDataSource, retryFailedQueue } from '../../../../../src/admin-actions';
import {
  isAdminUiCollectionSupported,
  isAdminUiIngestSupported,
} from '../../../../../src/admin-data';
import { ActionForm, PendingSubmitButton } from '../../../../../src/form-buttons';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import { AppShell, MetricStrip, PageHeader, RetryButton, StatusBadge } from '../../../../../src/ui';

export default async function IngestionPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await requireProjectAdminPage(projectSlug);

  return (
    <AppShell active="ingestion" canManageProject project={project}>
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
                  <strong>{source.ingestedCount}</strong>
                  ingested
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
              <details className="ingest-history">
                <summary
                  className="icon-button muted"
                  data-testid={`ingestion-history-${source.id}`}
                  title="Show ingest history"
                >
                  <Clock3 size={16} />
                  History
                </summary>
                <dl className="detail-list stacked">
                  {source.ingestHistory.map((entry) => (
                    <div key={entry.label}>
                      <dt>{entry.label}</dt>
                      <dd>{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
              <ActionForm action={collectAndIngestDataSource} className="inline-action-form">
                <input name="projectSlug" type="hidden" value={project.slug} />
                <input name="dataSourceId" type="hidden" value={source.id} />
                <PendingSubmitButton
                  className="icon-button"
                  disabled={
                    !isAdminUiCollectionSupported(source.sourceType) ||
                    !isAdminUiIngestSupported(source.sourceType)
                  }
                  pendingLabel="Running"
                  testId={`ingestion-collect-ingest-${source.id}`}
                  title="Collect and ingest source"
                >
                  Collect & Ingest
                </PendingSubmitButton>
              </ActionForm>
            </article>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
