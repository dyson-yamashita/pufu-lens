import { redirect } from 'next/navigation';
import { addProjectMember, removeProjectMember } from '../../../../src/admin-actions';
import { getProjectMembership } from '../../../../src/admin-db';
import { getSessionUserId } from '../../../../src/auth-session';
import { ActionForm, PendingSubmitButton } from '../../../../src/form-buttons';
import { AppShell, PageHeader } from '../../../../src/ui';

export default async function ProjectMembersPage({
  params,
}: {
  readonly params: Promise<{ readonly projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  const userId = await getSessionUserId();
  if (!userId) {
    redirect('/login');
  }
  const membership = await getProjectMembership(projectSlug, userId);
  const memberUserIds = new Set(membership.members.map((member) => member.id));
  const assignableUsers = membership.users.filter((user) => !memberUserIds.has(user.id));

  return (
    <AppShell active="members" project={membership.project}>
      <PageHeader
        title={`${membership.project.name} Members`}
        subtitle="プロジェクトに紐づくメンバーを確認します。"
      />
      <section className="panel" data-testid="project-member-list-panel">
        <div className="panel-heading">
          <div>
            <h2>Project Members</h2>
            <p className="mono">{membership.members.length} users</p>
          </div>
          {membership.canManageMembers ? (
            <ActionForm action={addProjectMember} className="table-edit-form compact">
              <input name="projectSlug" type="hidden" value={membership.project.slug} />
              <select
                aria-label="Add project member"
                data-testid="project-member-user-input"
                name="userId"
                required
              >
                {assignableUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email}
                  </option>
                ))}
              </select>
              <PendingSubmitButton
                className="primary-button"
                disabled={assignableUsers.length === 0}
                testId="project-member-submit-button"
                title="Add project member"
              >
                Add
              </PendingSubmitButton>
            </ActionForm>
          ) : null}
        </div>
        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Project Role</th>
                <th>App Role</th>
                <th>Joined</th>
                {membership.canManageMembers ? <th>Remove</th> : null}
              </tr>
            </thead>
            <tbody>
              {membership.members.map((member) => (
                <tr data-testid={`project-member-row-${member.id}`} key={member.id}>
                  <td>
                    <strong>{member.email}</strong>
                  </td>
                  <td>{member.name ?? '-'}</td>
                  <td>
                    <span className={`status-badge status-project-member-${member.projectRole}`}>
                      {member.projectRole}
                    </span>
                  </td>
                  <td>{member.role}</td>
                  <td>{member.createdAt}</td>
                  {membership.canManageMembers ? (
                    <td>
                      {member.removable ? (
                        <ActionForm
                          action={removeProjectMember}
                          className="table-edit-form compact"
                        >
                          <input name="projectSlug" type="hidden" value={membership.project.slug} />
                          <input name="userId" type="hidden" value={member.id} />
                          <PendingSubmitButton
                            className="icon-button muted"
                            testId={`project-member-remove-${member.id}`}
                            title="Remove project member"
                          >
                            Remove
                          </PendingSubmitButton>
                        </ActionForm>
                      ) : (
                        <span className="block-muted">-</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
