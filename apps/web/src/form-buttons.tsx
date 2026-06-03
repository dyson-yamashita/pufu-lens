'use client';

import { useFormStatus } from 'react-dom';

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
