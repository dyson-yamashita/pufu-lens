'use client';

import { type ChangeEvent, createElement, type KeyboardEvent, useState } from 'react';

export function chatQuestionTextareaPresentation({
  focused,
  value,
}: {
  readonly focused: boolean;
  readonly value: string;
}): {
  readonly className: string;
  readonly rows: 1 | 3;
} {
  const expanded = focused || value.length > 0;
  return {
    className: expanded ? 'chat-question-input-expanded' : 'chat-question-input-collapsed',
    rows: expanded ? 3 : 1,
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
  const [focused, setFocused] = useState(false);
  const presentation = chatQuestionTextareaPresentation({ focused, value });

  return createElement('textarea', {
    className: presentation.className,
    'data-testid': testId,
    disabled,
    id,
    onBlur: () => setFocused(false),
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    onFocus: () => setFocused(true),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    },
    rows: presentation.rows,
    value,
  });
}
