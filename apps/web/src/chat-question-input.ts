'use client';

import { type ChangeEvent, type ComponentProps, createElement, type KeyboardEvent } from 'react';
import TextareaAutosize from 'react-textarea-autosize';

export function chatQuestionTextareaPresentation(): {
  readonly className: string;
  readonly maxRows: 4;
  readonly minRows: 1;
} {
  return {
    className: 'chat-question-input',
    maxRows: 4,
    minRows: 1,
  };
}

export function ChatQuestionTextarea({
  disabled,
  id,
  onChange,
  testId,
  value,
}: {
  readonly disabled: boolean;
  readonly id: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly value: string;
}) {
  const presentation = chatQuestionTextareaPresentation();
  const props: ComponentProps<typeof TextareaAutosize> & { readonly 'data-testid': string } = {
    className: presentation.className,
    'data-testid': testId,
    disabled,
    id,
    maxRows: presentation.maxRows,
    minRows: presentation.minRows,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key === 'Enter' &&
        (event.ctrlKey || event.metaKey) &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    },
    value,
  };

  return createElement(TextareaAutosize, props);
}
