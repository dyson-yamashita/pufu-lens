'use client';

import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ActionForm, PendingSubmitButton } from './form-buttons';

type FormAction = (formData: FormData) => Promise<void>;

/**
 * Renders a confirmation dialog for deleting a project.
 *
 * @param action - Form action invoked to delete the project.
 * @param projectName - Project name the user must type to enable deletion.
 * @param projectSlug - Project identifier submitted with the delete request.
 */
export function ProjectDeleteDialog({
  action,
  projectName,
  projectSlug,
}: {
  readonly action: FormAction;
  readonly projectName: string;
  readonly projectSlug: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmationName, setConfirmationName] = useState('');
  const expectedProjectName = projectName.trim();
  const nameMatches = confirmationName.trim() === expectedProjectName;

  return (
    <>
      <button
        className="danger-button icon-button"
        data-testid="project-delete-button"
        onClick={() => {
          setConfirmationName('');
          dialogRef.current?.showModal();
        }}
        type="button"
      >
        <Trash2 size={16} />
        Delete project
      </button>
      <dialog
        className="modal-dialog"
        data-testid="project-delete-dialog"
        onClose={() => setConfirmationName('')}
        ref={dialogRef}
      >
        <div className="modal-card danger-zone-modal-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Danger zone</p>
              <h2>Delete project</h2>
            </div>
          </div>
          <p className="danger-zone-copy" data-testid="project-delete-warning-text">
            この操作は取り消せません。プロジェクト、メンバー、データソース、グラフ、レポートなど関連データが削除されます。
          </p>
          <ActionForm
            action={action}
            className="detail-edit-form project-delete-dialog-form"
            testId="project-delete-form"
          >
            <input name="projectSlug" type="hidden" value={projectSlug} />
            <label>
              <span>
                確認のため、プロジェクト名 <strong>{expectedProjectName}</strong> を入力してください
              </span>
              <input
                autoComplete="off"
                data-testid="project-delete-confirm-input"
                name="confirmationProjectName"
                onChange={(event) => setConfirmationName(event.target.value)}
                placeholder={expectedProjectName}
                required
                type="text"
                value={confirmationName}
              />
            </label>
            <div className="modal-actions">
              <button
                className="icon-button muted"
                data-testid="project-delete-cancel-button"
                onClick={() => dialogRef.current?.close()}
                type="button"
              >
                Cancel
              </button>
              <PendingSubmitButton
                className="danger-button icon-button"
                disabled={!nameMatches}
                pendingLabel="Deleting..."
                testId="project-delete-submit-button"
                title="Delete project permanently"
              >
                Delete project
              </PendingSubmitButton>
            </div>
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
