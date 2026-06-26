import Link from 'next/link';
import { mergeActors, rejectActorMergeCandidate } from '../../../../../src/admin-actions';
import type {
  ProjectActorAliasSummary,
  ProjectActorSummary,
} from '../../../../../src/admin-actors';
import { getProjectActorDirectory } from '../../../../../src/admin-db';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import { AppShell, PageHeader } from '../../../../../src/ui';

type ActorView = 'actors' | 'merge-candidates';

export default async function ActorsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
  readonly searchParams: Promise<{ readonly view?: string }>;
}) {
  const { projectSlug } = await params;
  const { view } = await searchParams;
  const project = await requireProjectAdminPage(projectSlug);
  const directory = await getProjectActorDirectory(projectSlug);
  const activeView = parseActorView(view);

  return (
    <AppShell active="actors" canManageProject project={project}>
      <PageHeader
        title={`${project.name} Actors`}
        subtitle="project scope の Actor、strong alias、weak alias、名寄せ候補を確認します。"
      />
      <div className="segmented-control actor-tabs" role="tablist" aria-label="Actor views">
        <Link
          aria-selected={activeView === 'actors'}
          className={activeView === 'actors' ? 'selected' : ''}
          data-testid="actor-view-actors-tab"
          href={`/projects/${project.slug}/admin/actors`}
          role="tab"
        >
          Actors
        </Link>
        <Link
          aria-selected={activeView === 'merge-candidates'}
          className={activeView === 'merge-candidates' ? 'selected' : ''}
          data-testid="actor-view-merge-candidates-tab"
          href={`/projects/${project.slug}/admin/actors?view=merge-candidates`}
          role="tab"
        >
          Merge Candidates
        </Link>
      </div>
      {activeView === 'actors' ? (
        <section className="panel">
          <div className="panel-heading">
            <h2>Actor List</h2>
            <span className="mono">{directory.actors.length} actors</span>
          </div>
          <div className="table-frame">
            <table data-testid="actor-table">
              <thead>
                <tr>
                  <th>Actor</th>
                  <th>Status</th>
                  <th>Strong</th>
                  <th>Weak</th>
                  <th>Sources</th>
                  <th>Primary</th>
                  <th>Graph node</th>
                </tr>
              </thead>
              <tbody>
                {directory.actors.map((actor) => (
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
                      <span className="mono">{actor.strongAliasCount}</span>
                    </td>
                    <td>
                      <span className="mono">{actor.weakAliasCount}</span>
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
      ) : (
        <section className="actor-candidate-list" data-testid="actor-merge-candidate-list">
          {directory.mergeCandidates.length > 0 ? (
            directory.mergeCandidates.map((candidate) => (
              <article className="panel actor-candidate-card" key={candidate.id}>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">confidence {candidate.confidence.toFixed(2)}</p>
                    <h2>
                      {candidate.actorA.displayName} / {candidate.actorB.displayName}
                    </h2>
                  </div>
                  <span className="status-badge status-draft">pending</span>
                </div>
                <div className="actor-compare-grid">
                  <ActorSummary actor={candidate.actorA} label="Actor A" />
                  <ActorSummary actor={candidate.actorB} label="Actor B" />
                </div>
                <dl className="detail-list">
                  <div>
                    <dt>Reasons</dt>
                    <dd>{candidate.reasons.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>{candidate.evidence.join(', ') || 'none'}</dd>
                  </div>
                </dl>
                <div className="actor-candidate-actions">
                  <MergeActorForm
                    candidateId={candidate.id}
                    primaryActor={candidate.actorA}
                    projectSlug={project.slug}
                    secondaryActor={candidate.actorB}
                  />
                  <MergeActorForm
                    candidateId={candidate.id}
                    primaryActor={candidate.actorB}
                    projectSlug={project.slug}
                    secondaryActor={candidate.actorA}
                  />
                  <RejectActorForm
                    actorA={candidate.actorA}
                    actorB={candidate.actorB}
                    candidateId={candidate.id}
                    projectSlug={project.slug}
                  />
                </div>
              </article>
            ))
          ) : (
            <section className="panel empty-state" data-testid="actor-merge-candidate-empty">
              <h2>No merge candidates</h2>
              <p>weak alias から確認が必要な同一 Actor 候補はまだ見つかっていません。</p>
            </section>
          )}
        </section>
      )}
    </AppShell>
  );
}

function MergeActorForm({
  candidateId,
  primaryActor,
  projectSlug,
  secondaryActor,
}: {
  readonly candidateId: string;
  readonly primaryActor: ProjectActorSummary;
  readonly projectSlug: string;
  readonly secondaryActor: ProjectActorSummary;
}) {
  return (
    <form action={mergeActors} className="actor-decision-form">
      <input name="projectSlug" type="hidden" value={projectSlug} />
      <input name="primaryActorId" type="hidden" value={primaryActor.id} />
      <input name="secondaryActorId" type="hidden" value={secondaryActor.id} />
      <input
        aria-label={`${secondaryActor.displayName} を ${primaryActor.displayName} にマージする理由`}
        name="reason"
        placeholder="Reason"
        type="text"
      />
      <button
        className="icon-button"
        data-testid={`actor-merge-${candidateId}-into-${primaryActor.id}`}
        type="submit"
      >
        Merge into {primaryActor.displayName}
      </button>
    </form>
  );
}

function RejectActorForm({
  actorA,
  actorB,
  candidateId,
  projectSlug,
}: {
  readonly actorA: ProjectActorSummary;
  readonly actorB: ProjectActorSummary;
  readonly candidateId: string;
  readonly projectSlug: string;
}) {
  return (
    <form action={rejectActorMergeCandidate} className="actor-decision-form">
      <input name="projectSlug" type="hidden" value={projectSlug} />
      <input name="primaryActorId" type="hidden" value={actorA.id} />
      <input name="secondaryActorId" type="hidden" value={actorB.id} />
      <input
        aria-label={`${actorA.displayName} と ${actorB.displayName} を reject する理由`}
        name="reason"
        placeholder="Reason"
        type="text"
      />
      <button
        className="icon-button muted"
        data-testid={`actor-reject-${candidateId}`}
        type="submit"
      >
        Reject
      </button>
    </form>
  );
}

function ActorSummary({
  actor,
  label,
}: {
  readonly actor: ProjectActorSummary;
  readonly label: string;
}) {
  const strongAliases = actor.aliases.filter((alias) => alias.strength === 'strong');
  const weakAliases = actor.aliases.filter((alias) => alias.strength === 'weak');

  return (
    <section className="actor-summary">
      <p className="eyebrow">{label}</p>
      <h3>{actor.displayName}</h3>
      <dl className="detail-list stacked">
        <div>
          <dt>Strong aliases</dt>
          <dd>{aliasList(strongAliases)}</dd>
        </div>
        <div>
          <dt>Weak aliases</dt>
          <dd>{aliasList(weakAliases)}</dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>{actor.sourceTypes.join(', ') || 'none'}</dd>
        </div>
      </dl>
    </section>
  );
}

function aliasList(aliases: readonly ProjectActorAliasSummary[]) {
  if (aliases.length === 0) {
    return 'none';
  }
  return aliases.map((alias) => `${alias.aliasType}:${alias.aliasValue}`).join(', ');
}

function parseActorView(value: string | undefined): ActorView {
  return value === 'merge-candidates' ? 'merge-candidates' : 'actors';
}
