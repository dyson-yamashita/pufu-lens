'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import type {
  ChatEditingMetadata,
  ChatResponse,
  ChatSource,
  PublicChatResponse,
  PublicChatSource,
} from './chat';

export type ChatThreadUserMessage = {
  readonly id: string;
  readonly role: 'user';
  readonly text: string;
};

export type ChatThreadPendingAssistantMessage = {
  readonly id: string;
  readonly role: 'assistant';
  readonly status: 'pending';
};

export type ChatThreadErrorAssistantMessage = {
  readonly id: string;
  readonly role: 'assistant';
  readonly status: 'error';
  readonly error: string;
};

export type ChatThreadCompleteAssistantMessage<T> = {
  readonly id: string;
  readonly role: 'assistant';
  readonly status: 'complete';
  readonly response: T;
};

export type ChatThreadMessage<T> =
  | ChatThreadUserMessage
  | ChatThreadPendingAssistantMessage
  | ChatThreadErrorAssistantMessage
  | ChatThreadCompleteAssistantMessage<T>;

export function createMessageId(prefix: string): string {
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 15);
  return `${prefix}-${randomId}`;
}

export function appendUserMessage<T>(
  messages: readonly ChatThreadMessage<T>[],
  text: string,
): ChatThreadMessage<T>[] {
  return [...messages, { id: createMessageId('user'), role: 'user', text }];
}

export function appendPendingAssistant<T>(messages: readonly ChatThreadMessage<T>[]): {
  messages: ChatThreadMessage<T>[];
  pendingId: string;
} {
  const pendingId = createMessageId('assistant');
  return {
    messages: [...messages, { id: pendingId, role: 'assistant', status: 'pending' }],
    pendingId,
  };
}

export function replacePendingAssistant<T>(
  messages: readonly ChatThreadMessage<T>[],
  pendingId: string,
  replacement: ChatThreadErrorAssistantMessage | ChatThreadCompleteAssistantMessage<T>,
): ChatThreadMessage<T>[] {
  return messages.map((message) => (message.id === pendingId ? replacement : message));
}

type ChatThreadProps = {
  readonly messages: readonly ChatThreadMessage<ChatResponse>[];
  readonly resultTestId: string;
};

export function PrivateChatThread({ messages, resultTestId }: ChatThreadProps) {
  const containerRef = useChatThreadScroll(chatThreadScrollKey(messages));

  return (
    <div className="chat-thread" data-testid={resultTestId} ref={containerRef}>
      {messages.map((message, index) => (
        <ChatThreadMessageItem index={index} key={message.id} message={message} variant="private" />
      ))}
    </div>
  );
}

type PublicChatThreadProps = {
  readonly messages: readonly ChatThreadMessage<PublicChatResponse>[];
  readonly resultTestId: string;
};

export function PublicChatThread({ messages, resultTestId }: PublicChatThreadProps) {
  const containerRef = useChatThreadScroll(chatThreadScrollKey(messages));

  return (
    <div className="chat-thread" data-testid={resultTestId} ref={containerRef}>
      {messages.map((message, index) => (
        <ChatThreadMessageItem index={index} key={message.id} message={message} variant="public" />
      ))}
    </div>
  );
}

function chatThreadScrollKey<T>(messages: readonly ChatThreadMessage<T>[]): string {
  return `${messages.length}:${messages.at(-1)?.id ?? ''}`;
}

function useChatThreadScroll(scrollKey: string) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void scrollKey;
    if (endRef.current) {
      endRef.current.scrollTop = endRef.current.scrollHeight;
    }
  }, [scrollKey]);

  return endRef;
}

function ChatThreadMessageItem({
  index,
  message,
  variant,
}: {
  readonly index: number;
  readonly message: ChatThreadMessage<ChatResponse | PublicChatResponse>;
  readonly variant: 'private' | 'public';
}) {
  if (message.role === 'user') {
    return (
      <article className="chat-message chat-message-user" data-testid={`chat-message-${index}`}>
        <ChatMarkdownText testId={`chat-user-message-${index}`} text={message.text} />
      </article>
    );
  }

  if (message.status === 'pending') {
    return (
      <article
        className="chat-message chat-message-assistant chat-message-pending"
        data-testid={`chat-message-${index}`}
      >
        <ChatMarkdownText testId={`chat-assistant-message-${index}`} text="Thinking..." />
      </article>
    );
  }

  if (message.status === 'error') {
    return (
      <article
        className="chat-message chat-message-assistant chat-message-error"
        data-testid={`chat-message-${index}`}
      >
        <div
          className="chat-message-text notice error"
          data-testid={`chat-assistant-message-${index}`}
        >
          {message.error}
        </div>
      </article>
    );
  }

  const { response } = message;
  return (
    <article className="chat-message chat-message-assistant" data-testid={`chat-message-${index}`}>
      <ChatMarkdownText testId={`chat-assistant-message-${index}`} text={response.answer} />
      {variant === 'private' ? (
        <PrivateSourceStrip index={index} sources={(response as ChatResponse).sources} />
      ) : (
        <PublicSourceStrip index={index} sources={(response as PublicChatResponse).sources} />
      )}
      <EditingDetails editing={response.editing} index={index} />
      <ToolCallsDetails index={index} toolCalls={response.toolCalls} />
    </article>
  );
}

function ChatMarkdownText({ testId, text }: { readonly testId: string; readonly text: string }) {
  return (
    <div className="chat-message-text chat-markdown" data-testid={testId}>
      {markdownBlocks(text)}
    </div>
  );
}

function markdownBlocks(text: string) {
  const blocks: ReactNode[] = [];
  const paragraph: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(paragraph.join('\n'))}</p>);
    paragraph.length = 0;
  }

  function flushList() {
    if (listItems.length > 0) {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {listItems.map((item) => (
            <li key={item}>{inlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      listItems = [];
    }
    if (orderedItems.length > 0) {
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {orderedItems.map((item) => (
            <li key={item}>{inlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      orderedItems = [];
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const heading = line.match(/^(#{1,3})\s+(.+)$/);

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (heading) {
      const headingLevel = heading[1];
      const headingText = heading[2];
      if (!headingLevel || !headingText) {
        continue;
      }
      flushParagraph();
      flushList();
      const HeadingTag = `h${headingLevel.length + 3}` as 'h4' | 'h5' | 'h6';
      blocks.push(
        <HeadingTag key={`h-${blocks.length}`}>{inlineMarkdown(headingText)}</HeadingTag>,
      );
      continue;
    }
    if (unordered) {
      const item = unordered[1];
      if (!item) {
        continue;
      }
      flushParagraph();
      flushList();
      listItems.push(item);
      continue;
    }
    if (ordered) {
      const item = ordered[1];
      if (!item) {
        continue;
      }
      flushParagraph();
      flushList();
      orderedItems.push(item);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return blocks.length ? blocks : <p>{text}</p>;
}

function inlineMarkdown(text: string) {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  match = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(<code key={`code-${match.index}`}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      nodes.push(
        <a href={match[5]} key={`link-${match.index}`} rel="noreferrer" target="_blank">
          {match[4]}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function PrivateSourceStrip({
  index,
  sources,
}: {
  readonly index: number;
  readonly sources?: readonly ChatSource[] | null;
}) {
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <div className="chat-message-sources" data-testid={`chat-message-sources-${index}`}>
      <div className="source-list source-list-compact">
        {sources.map((source) => (
          <article className="source-chip source-chip-compact" key={source.documentId}>
            <strong>{source.title}</strong>
            <span>{source.docType}</span>
            <small>{source.canonicalUri || source.documentId}</small>
          </article>
        ))}
      </div>
    </div>
  );
}

function PublicSourceStrip({
  index,
  sources,
}: {
  readonly index: number;
  readonly sources?: readonly PublicChatSource[] | null;
}) {
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <div className="chat-message-sources" data-testid={`chat-message-sources-${index}`}>
      <div className="source-list source-list-compact">
        {sources.map((source) => (
          <article
            className="source-chip source-chip-compact"
            key={`${source.sectionId}-${source.publicSourceId}`}
          >
            <strong>{source.publicSourceId}</strong>
            <span>{source.sectionId}</span>
            <small>{source.label}</small>
          </article>
        ))}
      </div>
    </div>
  );
}

function ToolCallsDetails({
  index,
  toolCalls,
}: {
  readonly index: number;
  readonly toolCalls?: readonly { readonly name: string; readonly resultCount: number }[] | null;
}) {
  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }
  const displayToolCalls = toolCallDisplayItems(toolCalls);

  return (
    <details className="chat-tool-calls" data-testid={`chat-message-tool-calls-${index}`}>
      <summary>Tool calls ({toolCalls.length})</summary>
      <div className="tool-call-list">
        {displayToolCalls.map((toolCall) => (
          <span className="status-badge" key={toolCall.key}>
            {toolCall.name}: {toolCall.resultCount}
          </span>
        ))}
      </div>
    </details>
  );
}

function EditingDetails({
  editing,
  index,
}: {
  readonly editing?: ChatEditingMetadata | null;
  readonly index: number;
}) {
  if (!editing) {
    return null;
  }

  return (
    <details className="chat-editing-metadata" data-testid={`chat-message-editing-${index}`}>
      <summary>Editing: {editing.inferredMode}</summary>
      <div className="tool-call-list">
        <span className="status-badge">confidence: {editing.confidence}</span>
        <span className="status-badge">type: {editing.questionType}</span>
        {editing.operations.map((operation) => (
          <span className="status-badge" key={operation}>
            {operation}
          </span>
        ))}
      </div>
      {editing.caveats.length > 0 ? (
        <p className="chat-editing-caveats">{editing.caveats.join(' / ')}</p>
      ) : null}
    </details>
  );
}

function toolCallDisplayItems(
  toolCalls: readonly { readonly name: string; readonly resultCount: number }[],
): Array<{ key: string; name: string; resultCount: number }> {
  const nameCounts = new Map<string, number>();
  return toolCalls.map((toolCall) => {
    const occurrence = (nameCounts.get(toolCall.name) ?? 0) + 1;
    nameCounts.set(toolCall.name, occurrence);
    return {
      key: `${toolCall.name}-${occurrence}`,
      name: toolCall.name,
      resultCount: toolCall.resultCount,
    };
  });
}
