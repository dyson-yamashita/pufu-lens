import { approveParserVersion, rejectParserVersion } from '../../../../../src/admin-actions';
import { requireProjectAdminPage } from '../../../../../src/project-page-auth';
import { AppShell, PageHeader, ParserActionButtons, StatusBadge } from '../../../../../src/ui';

export default async function ParserProfilesPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const project = await requireProjectAdminPage(projectSlug);

  return (
    <AppShell active="parser-profiles" canManageProject project={project}>
      <PageHeader
        title={`${project.name} Parser Profiles`}
        subtitle="active version、draft、validation report、held queue を確認します。"
        action={
          <button
            className="primary-button"
            data-testid="parser-profile-create-button"
            type="button"
          >
            New Profile
          </button>
        }
      />
      <section className="parser-grid" data-testid="parser-profile-list">
        {project.parserProfiles.map((profile) => (
          <article
            className="panel parser-card"
            data-testid={`parser-profile-card-${profile.id}`}
            key={profile.id}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{profile.sourceType}</p>
                <h2>{profile.name}</h2>
              </div>
              <StatusBadge status={profile.status} />
            </div>
            <dl className="detail-list stacked">
              <div>
                <dt>Active version</dt>
                <dd>{profile.activeVersion}</dd>
              </div>
              <div>
                <dt>Draft version</dt>
                <dd>{profile.draftVersion}</dd>
              </div>
              <div>
                <dt>Held queue</dt>
                <dd>{profile.heldQueueCount}</dd>
              </div>
              <div>
                <dt>Validation report</dt>
                <dd>{profile.validationReport}</dd>
              </div>
            </dl>
            <ParserActionButtons
              approveAction={approveParserVersion}
              profile={profile}
              projectSlug={project.slug}
              rejectAction={rejectParserVersion}
            />
          </article>
        ))}
      </section>
    </AppShell>
  );
}
