import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ActorMergeDecisionSummary } from '../../../../../../src/admin-actors';
import { getProjectActorDetail } from '../../../../../../src/admin-db';
import { requireProjectAdminPage } from '../../../../../../src/project-page-auth';
import { AppShell, PageHeader } from '../../../../../../src/ui';

export default async function ActorDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly actorId: string; readonly projectSlug: string }>;
}) {
  const { actorId, projectSlug } = await params;
  const project = await requireProjectAdminPage(projectSlug);
  const detail = await getProjectActorDetail(projectSlug, actorId);
  if (!detail) {
    notFound();
  }
  const { actor } = detail;

  return (
    <AppShell active="actors" canManageProject project={project}>
      <PageHeader
        title={actor.displayName}
        subtitle="Actor の alias、無効化状態、名寄せ判断履歴を確認します。"
      />
      <div className="action-row actor-detail-nav">
        <Link className="icon-button muted" href={`/projects/${project.slug}/admin/actors`}>
          Back to actors
        </Link>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <h2>Actor Detail</h2>
          <span className={`status-badge status-actor-${actor.status}`}>{actor.status}</span>
        </div>
        <dl className="detail-list">
          <div>
            <dt>Type</dt>
            <dd>{actor.actorType}</dd>
          </div>
          <div>
            <dt>Primary</dt>
            <dd>{actor.primaryEmail !== 'none' ? actor.primaryEmail : actor.primaryLogin}</dd>
          </div>
          <div>
            <dt>Graph node</dt>
            <dd className="mono truncate">{actor.graphNodeId}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{actor.createdAt}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{actor.updatedAt}</dd>
          </div>
          {actor.mergedIntoActorId !== 'none' ? (
            <div>
              <dt>Merged into</dt>
              <dd>
                <Link href={`/projects/${project.slug}/admin/actors/${actor.mergedIntoActorId}`}>
                  {actor.mergedIntoActorName}
                </Link>
              </dd>
            </div>
          ) : null}
          {actor.disabledAt !== 'none' ? (
            <div>
              <dt>Disabled</dt>
              <dd>
                {actor.disabledAt}
                {actor.disabledReason !== 'none' ? ` / ${actor.disabledReason}` : ''}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="panel actor-detail-section">
        <div className="panel-heading">
          <h2>Aliases</h2>
          <span className="mono">{detail.aliases.length} aliases</span>
        </div>
        {detail.aliases.length > 0 ? (
          <div className="table-frame">
            <table data-testid="actor-detail-alias-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Value</th>
                  <th>Strength</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {detail.aliases.map((alias) => (
                  <tr key={`${alias.aliasType}:${alias.aliasValue}`}>
                    <td>{alias.aliasType}</td>
                    <td className="truncate">{alias.aliasValue}</td>
                    <td>{alias.strength}</td>
                    <td className="truncate">{alias.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="content-preview-empty">No aliases.</p>
        )}
      </section>

      <section className="panel actor-detail-section">
        <div className="panel-heading">
          <h2>Decision History</h2>
          <span className="mono">{detail.decisions.length} decisions</span>
        </div>
        {detail.decisions.length > 0 ? (
          <div className="actor-decision-list" data-testid="actor-detail-decision-list">
            {detail.decisions.map((decision) => (
              <DecisionCard decision={decision} projectSlug={project.slug} key={decision.id} />
            ))}
          </div>
        ) : (
          <p className="content-preview-empty">No merge or reject decisions.</p>
        )}
      </section>
    </AppShell>
  );
}

function DecisionCard({
  decision,
  projectSlug,
}: {
  readonly decision: ActorMergeDecisionSummary;
  readonly projectSlug: string;
}) {
  return (
    <article className="actor-decision-card">
      <div className="content-preview-row-header">
        <strong>{decision.decisionType}</strong>
        <span className="content-preview-status">{decision.createdAt}</span>
      </div>
      <p className="content-preview-meta">
        <Link href={`/projects/${projectSlug}/admin/actors/${decision.primaryActorId}`}>
          {decision.primaryActorDisplayName}
        </Link>
        {' / '}
        <Link href={`/projects/${projectSlug}/admin/actors/${decision.secondaryActorId}`}>
          {decision.secondaryActorDisplayName}
        </Link>
      </p>
      <p className="content-preview-snippet">
        {decision.reason !== 'none' ? decision.reason : 'No reason recorded.'}
      </p>
    </article>
  );
}
