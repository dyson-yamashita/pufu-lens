'use client';

import { useEffect, useState } from 'react';

const mobileChatQuery = '(max-width: 720px)';

function useIsMobileChat(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(mobileChatQuery);
    const sync = () => setIsMobile(mediaQuery.matches);

    sync();
    mediaQuery.addEventListener('change', sync);

    return () => mediaQuery.removeEventListener('change', sync);
  }, []);

  return isMobile;
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
  const isMobile = useIsMobileChat();
  const [focused, setFocused] = useState(false);
  const expanded = !isMobile || focused || value.length > 0;
  const rows = expanded ? 3 : 1;

  return (
    <textarea
      className={expanded ? 'chat-question-input-expanded' : 'chat-question-input-collapsed'}
      data-testid={testId}
      disabled={disabled}
      id={id}
      onBlur={() => setFocused(false)}
      onChange={(event) => onChange(event.target.value)}
      onFocus={() => setFocused(true)}
      rows={rows}
      value={value}
    />
  );
}
