'use client';

import { type ChangeEvent, createElement, useState } from 'react';

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
  const expanded = focused || value.length > 0;
  const rows = expanded ? 3 : 1;

  return createElement('textarea', {
    className: expanded ? 'chat-question-input-expanded' : 'chat-question-input-collapsed',
    'data-testid': testId,
    disabled,
    id,
    onBlur: () => setFocused(false),
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value),
    onFocus: () => setFocused(true),
    rows,
    value,
  });
}
