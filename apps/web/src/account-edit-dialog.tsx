'use client';

import { Pencil } from 'lucide-react';
import { useRef } from 'react';
import type { AppMemberSummary } from './admin-db';
import { ActionForm, PendingSubmitButton } from './form-buttons';

type FormAction = (formData: FormData) => Promise<void>;

export function AccountEditDialog({
  action,
  member,
}: {
  readonly action: FormAction;
  readonly member: AppMemberSummary;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        className="icon-button"
        data-testid={`member-edit-button-${member.id}`}
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        <Pencil size={16} />
        Edit
      </button>
      <dialog
        className="modal-dialog"
        data-testid={`member-edit-dialog-${member.id}`}
        ref={dialogRef}
      >
        <div className="modal-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Account</p>
              <h2>{member.email}</h2>
            </div>
          </div>
          <ActionForm
            action={action}
            className="detail-edit-form"
            onSuccess={() => dialogRef.current?.close()}
          >
            <input name="userId" type="hidden" value={member.id} />
            <label>
              <span>Name</span>
              <input
                aria-label={`${member.email} name`}
                data-testid={`member-edit-name-${member.id}`}
                defaultValue={member.name ?? ''}
                name="name"
                placeholder="Name"
                type="text"
              />
            </label>
            <label>
              <span>Role</span>
              <select
                aria-label={`${member.email} role`}
                data-testid={`member-edit-role-${member.id}`}
                defaultValue={member.role}
                name="role"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label>
              <span>Password</span>
              <input
                autoComplete="new-password"
                aria-label={`${member.email} password`}
                data-testid={`member-edit-password-${member.id}`}
                minLength={8}
                name="password"
                placeholder="New password"
                type="password"
              />
            </label>
            <label>
              <span>Confirm Password</span>
              <input
                autoComplete="new-password"
                aria-label={`${member.email} password confirmation`}
                data-testid={`member-edit-password-confirm-${member.id}`}
                minLength={8}
                name="passwordConfirm"
                placeholder="Confirm password"
                type="password"
              />
            </label>
            <div className="modal-actions">
              <button
                className="icon-button muted"
                onClick={() => dialogRef.current?.close()}
                type="button"
              >
                Cancel
              </button>
              <PendingSubmitButton
                className="primary-button"
                testId={`member-save-${member.id}`}
                title="Save account"
              >
                Save
              </PendingSubmitButton>
            </div>
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
