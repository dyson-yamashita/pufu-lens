'use client';

import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { shouldProceedWithConfirm } from './form-confirm.ts';

type FormAction = (formData: FormData) => Promise<void>;

interface ActionFormState {
  readonly error?: string;
}

const initialActionFormState: ActionFormState = {};

export function ActionForm({
  action,
  children,
  className,
  confirmMessage,
  onSuccess,
  testId,
}: {
  readonly action: FormAction;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly confirmMessage?: string;
  readonly onSuccess?: () => void;
  readonly testId?: string;
}) {
  const [state, formAction] = useActionState(
    async (_previousState: ActionFormState, formData: FormData): Promise<ActionFormState> => {
      try {
        await action(formData);
        onSuccess?.();
        return {};
      } catch (error) {
        if (isRedirectError(error)) {
          throw error;
        }
        return { error: error instanceof Error ? error.message : 'Action failed.' };
      }
    },
    initialActionFormState,
  );

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    const message = confirmMessage;
    if (!message) {
      return;
    }
    if (!shouldProceedWithConfirm(message, () => window.confirm(message))) {
      event.preventDefault();
    }
  };

  return (
    <form
      action={formAction}
      className={className}
      data-testid={testId}
      onSubmit={confirmMessage ? handleSubmit : undefined}
    >
      {children}
      {state.error ? (
        <p className="action-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function PendingSubmitButton({
  children,
  className,
  disabled,
  pendingLabel,
  testId,
  title,
}: {
  readonly children: React.ReactNode;
  readonly className: string;
  readonly disabled?: boolean;
  readonly pendingLabel?: string;
  readonly testId: string;
  readonly title: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      aria-busy={pending}
      className={className}
      data-pending={pending ? 'true' : undefined}
      data-testid={testId}
      disabled={disabled || pending}
      title={title}
      type="submit"
    >
      {pending ? (
        <>
          <span aria-hidden="true" className="button-spinner" />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
