'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

type FormAction = (formData: FormData) => Promise<void>;

interface ActionFormState {
  readonly error?: string;
}

const initialActionFormState: ActionFormState = {};

export function ActionForm({
  action,
  children,
  className,
  onSuccess,
}: {
  readonly action: FormAction;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly onSuccess?: () => void;
}) {
  const [state, formAction] = useActionState(
    async (_previousState: ActionFormState, formData: FormData): Promise<ActionFormState> => {
      try {
        await action(formData);
        onSuccess?.();
        return {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Action failed.' };
      }
    },
    initialActionFormState,
  );

  return (
    <form action={formAction} className={className}>
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
  testId,
  title,
}: {
  readonly children: React.ReactNode;
  readonly className: string;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly title: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={className}
      data-testid={testId}
      disabled={disabled || pending}
      title={title}
      type="submit"
    >
      {children}
    </button>
  );
}
