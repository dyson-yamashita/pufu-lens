'use client';

import { Plus } from 'lucide-react';
import { useRef } from 'react';
import { ActionForm, PendingSubmitButton } from './form-buttons';

type FormAction = (formData: FormData) => Promise<void>;

export function ProjectCreateDialog({ action }: { readonly action: FormAction }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        className="primary-button"
        data-testid="project-create-button"
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        <Plus size={18} />
        Add project
      </button>
      <dialog className="modal-dialog" data-testid="project-create-dialog" ref={dialogRef}>
        <div className="modal-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Project</p>
              <h2>Add project</h2>
            </div>
          </div>
          <ActionForm
            action={action}
            className="project-create-form project-create-dialog-form"
            onSuccess={() => dialogRef.current?.close()}
          >
            <label>
              <span>Name</span>
              <input data-testid="project-name-input" name="name" required type="text" />
            </label>
            <label>
              <span>Slug</span>
              <input
                data-testid="project-slug-input"
                name="slug"
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                placeholder="project-alpha"
                required
                type="text"
              />
            </label>
            <label className="project-create-description">
              <span>Description</span>
              <textarea data-testid="project-description-input" name="description" rows={2} />
            </label>
            <label>
              <span>Visibility</span>
              <select
                data-testid="project-visibility-select"
                defaultValue="private"
                name="visibility"
              >
                <option value="private">private</option>
                <option value="public">public</option>
              </select>
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
                testId="project-submit-button"
                title="Create project"
              >
                Create project
              </PendingSubmitButton>
            </div>
          </ActionForm>
        </div>
      </dialog>
    </>
  );
}
