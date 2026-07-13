export type ChatThreadPendingAssistantMessage = {
  readonly id: string;
  readonly progressLabel?: string;
  readonly role: 'assistant';
  readonly status: 'pending';
};

export type ChatThreadMessageState<T> =
  | ChatThreadPendingAssistantMessage
  | {
      readonly id: string;
      readonly role: 'user';
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly role: 'assistant';
      readonly status: 'error';
      readonly error: string;
    }
  | {
      readonly id: string;
      readonly role: 'assistant';
      readonly status: 'complete';
      readonly response: T;
    };

export function createMessageId(prefix: string): string {
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 15);
  return `${prefix}-${randomId}`;
}

export function appendPendingAssistant<T>(messages: readonly ChatThreadMessageState<T>[]): {
  messages: ChatThreadMessageState<T>[];
  pendingId: string;
} {
  const pendingId = createMessageId('assistant');
  return {
    messages: [...messages, { id: pendingId, role: 'assistant', status: 'pending' }],
    pendingId,
  };
}

export function updatePendingAssistantProgress<T>(
  messages: readonly ChatThreadMessageState<T>[],
  pendingId: string,
  progressLabel: string,
): ChatThreadMessageState<T>[] {
  return messages.map((message) =>
    message.id === pendingId && message.role === 'assistant' && message.status === 'pending'
      ? { ...message, progressLabel }
      : message,
  );
}

export function replacePendingAssistant<T>(
  messages: readonly ChatThreadMessageState<T>[],
  pendingId: string,
  replacement: Extract<
    ChatThreadMessageState<T>,
    { readonly status: 'complete' } | { readonly status: 'error' }
  >,
): ChatThreadMessageState<T>[] {
  return messages.map((message) => (message.id === pendingId ? replacement : message));
}
