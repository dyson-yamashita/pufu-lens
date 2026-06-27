import Link from 'next/link';
import { mergeActors } from '../../../../../src/admin-actions';
import type { ActorStatus, ProjectActorSummary } from '../../../../../src/admin-actors';
import { getProjectActorDirectory } from '../../../../../src/admin-db';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import { AppShell, PageHeader } from '../../../../../src/ui';

type ActorStatusFilter = ActorStatus | 'all';

export default async function ActorsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
  readonly searchParams: Promise<{
    readonly status?: string;
  }>;
}) {
  const { projectSlug } = await params;
  const { status } = await searchParams;
  const project = await requireProjectAdminPage(projectSlug);
  const directory = await getProjectActorDirectory(projectSlug);
  const statusFilter = parseActorStatusFilter(status);
  const filteredActors =
    statusFilter === 'all'
      ? directory.actors
      : directory.actors.filter((actor) => actor.status === statusFilter);

  return (
    <AppShell active="actors" canManageProject project={project}>
      <PageHeader
        title={`${project.name} Actors`}
        subtitle="project scope の Actor、alias、名寄せ判断履歴を確認します。"
      />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Actor List</h2>
            <span className="mono">
              {filteredActors.length} / {directory.actors.length} actors
            </span>
          </div>
          <ActorStatusFilterForm projectSlug={project.slug} statusFilter={statusFilter} />
        </div>
        <ManualMergePanel actors={directory.actors} projectSlug={project.slug} />
        <div className="table-frame">
          <table data-testid="actor-table">
            <thead>
              <tr>
                <th>Actor</th>
                <th>Status</th>
                <th>Alias</th>
                <th>Sources</th>
                <th>Primary</th>
                <th>Graph node</th>
              </tr>
            </thead>
            <tbody>
              {filteredActors.map((actor) => (
                <tr data-testid={`actor-row-${actor.id}`} key={actor.id}>
                  <td>
                    <span className="source-name">
                      <span>
                        <strong>
                          <Link href={`/projects/${project.slug}/admin/actors/${actor.id}`}>
                            {actor.displayName}
                          </Link>
                        </strong>
                        <small>{actor.actorType}</small>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className={`status-badge status-actor-${actor.status}`}>
                      {actor.status}
                    </span>
                  </td>
                  <td>
                    <span className="mono">{actor.aliasCount}</span>
                  </td>
                  <td>
                    <span className="alias-chip-list">
                      {actor.sourceTypes.length > 0
                        ? actor.sourceTypes.map((sourceType) => (
                            <span className="alias-chip" key={sourceType}>
                              {sourceType}
                            </span>
                          ))
                        : 'none'}
                    </span>
                  </td>
                  <td className="truncate">
                    {actor.primaryEmail !== 'none' ? actor.primaryEmail : actor.primaryLogin}
                  </td>
                  <td className="truncate mono">{actor.graphNodeId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}

function ManualMergePanel({
  actors,
  projectSlug,
}: {
  readonly actors: readonly ProjectActorSummary[];
  readonly projectSlug: string;
}) {
  const activeActors = actors.filter((actor) => actor.status === 'active');

  return (
    <details className="actor-manual-merge-panel" data-testid="actor-manual-merge-panel">
      <summary className="actor-manual-merge-summary">
        <div>
          <p className="eyebrow">Manual merge</p>
          <h3>Actor を統合するには?</h3>
        </div>
      </summary>
      <form
        action={mergeActors}
        className="actor-decision-form actor-manual-merge-form"
        data-testid="actor-manual-merge-form"
      >
        <input name="projectSlug" type="hidden" value={projectSlug} />
        <label>
          <span>Primary</span>
          <select
            aria-label="統合先 Actor"
            data-testid="actor-manual-merge-primary-select"
            name="primaryActorId"
            required
          >
            <option value="">Select primary actor</option>
            {activeActors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actorSelectLabel(actor)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Secondary</span>
          <select
            aria-label="統合される Actor"
            data-testid="actor-manual-merge-secondary-select"
            name="secondaryActorId"
            required
          >
            <option value="">Select secondary actor</option>
            {activeActors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actorSelectLabel(actor)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Reason</span>
          <input
            aria-label="手動マージする理由"
            data-testid="actor-manual-merge-reason-input"
            name="reason"
            placeholder="Reason"
            type="text"
          />
        </label>
        <button className="icon-button" data-testid="actor-manual-merge-submit" type="submit">
          Merge selected
        </button>
      </form>
      <p className="actor-manual-merge-message">
        active Actor から統合先と統合対象を 1 件ずつ選択してください。同じ Actor
        はマージできません。
      </p>
    </details>
  );
}

function ActorStatusFilterForm({
  projectSlug,
  statusFilter,
}: {
  readonly projectSlug: string;
  readonly statusFilter: ActorStatusFilter;
}) {
  return (
    <form
      action={`/projects/${projectSlug}/admin/actors`}
      className="actor-filter-form"
      data-testid="actor-status-filter-form"
      method="get"
    >
      <label>
        <span>Status</span>
        <select
          aria-label="Actor status filter"
          data-testid="actor-status-filter-select"
          defaultValue={statusFilter}
          name="status"
        >
          <option value="active">active</option>
          <option value="merged">merged</option>
          <option value="disabled">disabled</option>
          <option value="all">all</option>
        </select>
      </label>
      <button className="icon-button muted" data-testid="actor-status-filter-submit" type="submit">
        Apply
      </button>
    </form>
  );
}

function parseActorStatusFilter(value: string | undefined): ActorStatusFilter {
  if (value === 'all' || value === 'merged' || value === 'disabled') {
    return value;
  }
  return 'active';
}

function actorSelectLabel(actor: ProjectActorSummary): string {
  const identifier =
    actor.primaryEmail !== 'none'
      ? actor.primaryEmail
      : actor.primaryLogin !== 'none'
        ? actor.primaryLogin
        : actor.graphNodeId;
  return `${actor.displayName} (${identifier})`;
}
