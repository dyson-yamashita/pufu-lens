'use client';

import { useEffect, useRef } from 'react';
import type {
  ChatEditingMetadata,
  ChatResponse,
  ChatSource,
  PrivateChatHistoryItem,
  PublicChatResponse,
  PublicChatSource,
} from './chat';
import {
  appendPendingAssistant,
  createMessageId,
  replacePendingAssistant,
  updatePendingAssistantProgress,
} from './chat-thread-message-state';
import { MarkdownContent } from './markdown-content';

export type ChatThreadUserMessage = {
  readonly id: string;
  readonly role: 'user';
  readonly text: string;
};

export type ChatThreadPendingAssistantMessage = {
  readonly id: string;
  readonly progressLabel?: string;
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

export {
  appendPendingAssistant,
  createMessageId,
  replacePendingAssistant,
  updatePendingAssistantProgress,
};

export function appendUserMessage<T>(
  messages: readonly ChatThreadMessage<T>[],
  text: string,
): ChatThreadMessage<T>[] {
  return [...messages, { id: createMessageId('user'), role: 'user', text }];
}

export function mapPrivateChatHistoryToThreadMessages(
  history: readonly PrivateChatHistoryItem[],
  projectSlug: string,
): ChatThreadMessage<ChatResponse>[] {
  const messages: ChatThreadMessage<ChatResponse>[] = [];
  for (const turn of history) {
    messages.push({
      id: `history-user-${turn.id}`,
      role: 'user',
      text: turn.question,
    });
    messages.push({
      id: `history-assistant-${turn.id}`,
      role: 'assistant',
      response: {
        answer: turn.answer,
        ...(turn.editing ? { editing: turn.editing } : {}),
        projectSlug,
        sources: turn.sources,
        status: 'answered',
        toolCalls: turn.toolCalls,
      },
      status: 'complete',
    });
  }
  return messages;
}

type ChatThreadProps = {
  readonly introMessage?: string;
  readonly messages: readonly ChatThreadMessage<ChatResponse>[];
  readonly resultTestId: string;
};

export function PrivateChatThread({ introMessage, messages, resultTestId }: ChatThreadProps) {
  const containerRef = useChatThreadScroll(chatThreadScrollKey(messages));

  return (
    <div className="chat-thread" data-testid={resultTestId} ref={containerRef}>
      {messages.length === 0 && introMessage ? (
        <article
          className="chat-message chat-message-assistant chat-message-intro"
          data-testid="chat-intro-message"
        >
          <ChatMarkdownText testId="chat-assistant-intro-message" text={introMessage} />
        </article>
      ) : null}
      {messages.map((message, index) => (
        <ChatThreadMessageItem index={index} key={message.id} message={message} variant="private" />
      ))}
    </div>
  );
}

type PublicChatThreadProps = {
  readonly introMessage?: string;
  readonly messages: readonly ChatThreadMessage<PublicChatResponse>[];
  readonly resultTestId: string;
};

export function PublicChatThread({ introMessage, messages, resultTestId }: PublicChatThreadProps) {
  const containerRef = useChatThreadScroll(chatThreadScrollKey(messages));

  return (
    <div className="chat-thread" data-testid={resultTestId} ref={containerRef}>
      {messages.length === 0 && introMessage ? (
        <article
          className="chat-message chat-message-assistant chat-message-intro"
          data-testid="public-chat-intro-message"
        >
          <ChatMarkdownText testId="public-chat-assistant-intro-message" text={introMessage} />
        </article>
      ) : null}
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
        <PendingThinking
          progressLabel={message.progressLabel}
          testId={`chat-assistant-message-${index}`}
        />
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
      <EditingDetails editing={response.editing} index={index} />
      {variant === 'private' ? (
        <PrivateSourceStrip index={index} sources={(response as ChatResponse).sources} />
      ) : (
        <PublicSourceStrip index={index} sources={(response as PublicChatResponse).sources} />
      )}
      <ToolCallsDetails index={index} toolCalls={response.toolCalls} />
    </article>
  );
}

function PendingThinking({
  progressLabel,
  testId,
}: {
  readonly progressLabel?: string;
  readonly testId: string;
}) {
  return (
    <div className="chat-thinking-block">
      <div className="chat-message-text chat-thinking" data-testid={testId} role="status">
        <span>Thinking</span>
        <span aria-hidden="true" className="chat-thinking-dots">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
      {progressLabel ? (
        <p aria-live="polite" className="chat-thinking-stage" data-testid={`${testId}-stage`}>
          {progressLabel}
        </p>
      ) : null}
    </div>
  );
}

function ChatMarkdownText({ testId, text }: { readonly testId: string; readonly text: string }) {
  return (
    <MarkdownContent className="chat-message-text chat-markdown" testId={testId} text={text} />
  );
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
    <details className="chat-message-sources" data-testid={`chat-message-sources-${index}`}>
      <summary data-testid={`chat-message-sources-toggle-${index}`}>
        Sources ({sources.length})
      </summary>
      <div className="source-list source-list-compact">
        {sources.map((source) => (
          <article
            className="source-chip source-chip-compact"
            data-testid={`chat-message-source-${index}-${source.documentId}`}
            key={source.documentId}
          >
            <strong>{source.title}</strong>
            <span>{source.docType}</span>
            <small>{source.canonicalUri || source.documentId}</small>
          </article>
        ))}
      </div>
    </details>
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
    <details className="chat-message-sources" data-testid={`chat-message-sources-${index}`}>
      <summary data-testid={`chat-message-sources-toggle-${index}`}>
        Sources ({sources.length})
      </summary>
      <div className="source-list source-list-compact">
        {sources.map((source) => (
          <article
            className="source-chip source-chip-compact"
            data-testid={`chat-message-source-${index}-${source.publicSourceId}`}
            key={`${source.sectionId}-${source.publicSourceId}`}
          >
            <strong>{source.publicSourceId}</strong>
            <span>{source.sectionId}</span>
            <small>{source.label}</small>
          </article>
        ))}
      </div>
    </details>
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
  const operations = editing.operations ?? [];
  const caveats = editing.caveats ?? [];

  return (
    <details className="chat-editing-metadata" data-testid={`chat-message-editing-${index}`}>
      <summary>編集方針: {editingModeLabel(editing.inferredMode)}</summary>
      <div className="tool-call-list">
        <span className="status-badge">確度: {editingConfidenceLabel(editing.confidence)}</span>
        <span className="status-badge">種別: {editingQuestionTypeLabel(editing.questionType)}</span>
        {operations.map((operation) => (
          <span className="status-badge" key={operation}>
            {operation}
          </span>
        ))}
      </div>
      {caveats.length > 0 ? <p className="chat-editing-caveats">{caveats.join(' / ')}</p> : null}
    </details>
  );
}

function editingModeLabel(mode: ChatEditingMetadata['inferredMode']): string {
  const labels: Record<ChatEditingMetadata['inferredMode'], string> = {
    default: '通常回答',
    issue_mapping: '論点整理',
    next_actions: '次の行動',
    risk_scan: 'リスク確認',
    structure: '構造化',
    summary: '要約',
    timeline: '時系列',
  };
  return labels[mode];
}

function editingConfidenceLabel(confidence: ChatEditingMetadata['confidence']): string {
  const labels: Record<ChatEditingMetadata['confidence'], string> = {
    high: '高',
    low: '低',
    medium: '中',
  };
  return labels[confidence];
}

function editingQuestionTypeLabel(questionType: ChatEditingMetadata['questionType']): string {
  const labels: Record<ChatEditingMetadata['questionType'], string> = {
    fact: '事実確認',
    planning: '計画',
    public_explanation: '公開説明',
    risk: 'リスク',
    status: '状態確認',
    timeline: '時系列',
    unknown: '未分類',
  };
  return labels[questionType];
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
