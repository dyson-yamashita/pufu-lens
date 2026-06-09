import { redirect } from 'next/navigation';
import { auth } from '../../auth';
import { AccountEditDialog } from '../../src/account-edit-dialog';
import { createMember, updateMember } from '../../src/admin-actions';
import { listAppMembersForUser } from '../../src/admin-db';
import { ActionForm, PendingSubmitButton } from '../../src/form-buttons';
import { AppShell, PageHeader } from '../../src/ui';

export default async function MembersPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect('/login');
  }
  const directory = await listAppMembersForUser(userId);

  return (
    <AppShell active="members">
      <PageHeader
        title="Accounts"
        subtitle="アプリにログインできるアカウントを確認し、全体 role を管理します。"
      />
      {directory.canManageMembers ? (
        <details className="panel create-project-panel" data-testid="member-create-panel">
          <summary className="primary-button" data-testid="member-create-button">
            Add Account
          </summary>
          <ActionForm action={createMember} className="project-create-form member-create-form">
            <label>
              <span>Email</span>
              <input data-testid="member-email-input" name="email" required type="email" />
            </label>
            <label>
              <span>Name</span>
              <input data-testid="member-name-input" name="name" type="text" />
            </label>
            <label>
              <span>Role</span>
              <select data-testid="member-role-input" defaultValue="member" name="role" required>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label>
              <span>Password</span>
              <input
                autoComplete="new-password"
                data-testid="member-password-input"
                minLength={8}
                name="password"
                type="password"
              />
            </label>
            <label>
              <span>Confirm Password</span>
              <input
                autoComplete="new-password"
                data-testid="member-password-confirm-input"
                minLength={8}
                name="passwordConfirm"
                type="password"
              />
            </label>
            <PendingSubmitButton
              className="primary-button"
              testId="member-submit-button"
              title="Create account"
            >
              Create
            </PendingSubmitButton>
          </ActionForm>
        </details>
      ) : null}
      <section className="panel" data-testid="member-list-panel">
        <div className="panel-heading">
          <div>
            <h2>Account List</h2>
            <p className="mono">{directory.members.length} users</p>
          </div>
        </div>
        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Created</th>
                <th>Edit</th>
              </tr>
            </thead>
            <tbody>
              {directory.members.map((member) => (
                <tr data-testid={`member-row-${member.id}`} key={member.id}>
                  <td>
                    <strong>{member.email}</strong>
                  </td>
                  <td>{member.name ?? '-'}</td>
                  <td>
                    <span className={`status-badge status-member-${member.role}`}>
                      {member.role}
                    </span>
                  </td>
                  <td>{member.createdAt}</td>
                  {directory.canManageMembers ? (
                    <td>
                      <AccountEditDialog action={updateMember} member={member} />
                    </td>
                  ) : (
                    <td>-</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
