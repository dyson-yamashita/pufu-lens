'use client';

import { ArrowUp, History, MessageSquarePlus, Mic, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ChatErrorResponse,
  type ChatResponse,
  chatErrorMessage,
  DB_OUTSIDE_BUSINESS_HOURS_CODE,
  isChatErrorResponseBody,
  isChatResponseBody,
  isDbOutsideBusinessHoursError,
  isDbOutsideBusinessHoursResponse,
  isPrivateChatHistoryListResponse,
  isPublicChatResponseBody,
  type PrivateChatHistoryItem,
  type PrivateChatHistoryListResponse,
  type PublicChatResponse,
  type PublicProjectChatUnavailableResponse,
} from './chat';
import { ChatQuestionTextarea } from './chat-question-input';
import {
  appendPendingAssistant,
  appendUserMessage,
  type ChatThreadMessage,
  createMessageId,
  mapPrivateChatHistoryToThreadMessages,
  PrivateChatThread,
  PublicChatThread,
  replacePendingAssistant,
} from './chat-thread';
import { useSpeechInput } from './speech-input';

const CHAT_HISTORY_TIME_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
});

function projectChatIntroMessage(projectName: string): string {
  return `プロジェクト ${projectName}  についてご質問ください。\n\n例： ${projectName}  について教えてください。`;
}

export function ChatPanel({
  disabled,
  projectName,
  projectSlug,
}: {
  readonly disabled: boolean;
  readonly projectName: string;
  readonly projectSlug: string;
}) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatThreadMessage<ChatResponse>[]>([]);
  const [historyItems, setHistoryItems] = useState<readonly PrivateChatHistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const historyDialogRef = useRef<HTMLDialogElement>(null);
  const historyRequestSeqRef = useRef(0);
  const chatDisabled = disabled || unavailable;
  const closeHistoryDialog = useCallback(() => {
    historyDialogRef.current?.close();
  }, []);

  useEffect(() => {
    historyRequestSeqRef.current += 1;
    setMessages([]);
    setHistoryItems([]);
    setSelectedHistoryId(null);
    setHistoryError(null);
    setHistoryLoading(false);
    setUnavailable(false);
    closeHistoryDialog();
    void projectSlug;
  }, [closeHistoryDialog, projectSlug]);
  const speechInput = useSpeechInput({
    disabled: chatDisabled || pending,
    setValue: setQuestion,
    value: question,
  });

  const loadHistory = useCallback(async () => {
    if (chatDisabled) {
      return;
    }
    const requestSeq = ++historyRequestSeqRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await fetch(`/api/projects/${projectSlug}/chat/history`);
      const isJson = result.headers.get('content-type')?.includes('application/json') ?? false;
      const body = isJson
        ? ((await result.json()) as PrivateChatHistoryListResponse | ChatErrorResponse)
        : null;
      if (!result.ok) {
        const errorBody = isChatErrorResponseBody(body) ? body : null;
        if (isDbOutsideBusinessHoursError(errorBody)) {
          setUnavailable(true);
          return;
        }
        throw new Error(chatErrorMessage(errorBody, result.status));
      }
      if (!isPrivateChatHistoryListResponse(body)) {
        throw new Error('Chat history API returned an invalid response.');
      }
      if (requestSeq !== historyRequestSeqRef.current) {
        return;
      }
      setHistoryItems(body.items);
    } catch (caught) {
      if (requestSeq === historyRequestSeqRef.current) {
        setHistoryError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (requestSeq === historyRequestSeqRef.current) {
        setHistoryLoading(false);
      }
    }
  }, [chatDisabled, projectSlug]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const openHistoryDialog = useCallback(() => {
    if (chatDisabled) {
      return;
    }
    void loadHistory();
    if (!historyDialogRef.current?.open) {
      historyDialogRef.current?.showModal();
    }
  }, [chatDisabled, loadHistory]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || chatDisabled || pending) {
      return;
    }

    const includeHistory = messages.length > 0 || selectedHistoryId !== null;
    const baseMessages = selectedHistoryId ? [] : messages;
    const nextMessages = appendUserMessage(baseMessages, trimmedQuestion);
    const { messages: messagesWithPending, pendingId } = appendPendingAssistant(nextMessages);
    setMessages(messagesWithPending);
    setSelectedHistoryId(null);
    setQuestion('');
    setPending(true);

    try {
      const result = await fetch(`/api/projects/${projectSlug}/chat`, {
        body: JSON.stringify({ includeHistory, question: trimmedQuestion }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const isJson = result.headers.get('content-type')?.includes('application/json') ?? false;
      const body = isJson ? ((await result.json()) as ChatResponse | ChatErrorResponse) : null;
      if (!result.ok) {
        if (isDbOutsideBusinessHoursResponse(body)) {
          setUnavailable(true);
          throw new Error(DB_OUTSIDE_BUSINESS_HOURS_CODE);
        }
        throw new Error(chatErrorMessage(body, result.status));
      }
      if (!isChatResponseBody(body)) {
        throw new Error('Chat API returned an invalid response.');
      }
      setMessages((current) =>
        replacePendingAssistant(current, pendingId, {
          id: createMessageId('assistant'),
          role: 'assistant',
          response: body,
          status: 'complete',
        }),
      );
    } catch (caught) {
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      setMessages((current) =>
        replacePendingAssistant(current, pendingId, {
          error: errorMessage,
          id: createMessageId('assistant'),
          role: 'assistant',
          status: 'error',
        }),
      );
    } finally {
      setPending(false);
      void loadHistory();
    }
  }

  return (
    <section className="panel chat-panel" data-testid="chat-panel">
      <div className="chat-history-header" data-testid="chat-history-header">
        <div className="chat-history-controls">
          <button
            aria-label="New chat"
            className="chat-icon-button chat-action-button"
            data-testid="chat-new-button"
            disabled={pending}
            onClick={() => {
              setMessages([]);
              setSelectedHistoryId(null);
              setQuestion('');
            }}
            title="New chat"
            type="button"
          >
            <MessageSquarePlus size={16} />
            <span className="chat-action-button-label">New</span>
          </button>
          <button
            aria-label="Open chat history"
            className="chat-icon-button chat-action-button"
            data-testid="chat-history-open-button"
            disabled={chatDisabled || pending}
            onClick={openHistoryDialog}
            title="Open chat history"
            type="button"
          >
            <History size={16} />
            <span className="chat-action-button-label">History</span>
          </button>
        </div>
      </div>
      <dialog
        aria-labelledby="chat-history-dialog-title"
        className="modal-dialog chat-history-dialog"
        data-testid="chat-history-dialog"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            closeHistoryDialog();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            closeHistoryDialog();
          }
        }}
        ref={historyDialogRef}
      >
        <div className="modal-card chat-history-modal-card">
          <button
            aria-label="Close chat history"
            className="modal-close-button"
            data-testid="chat-history-close-button"
            onClick={closeHistoryDialog}
            title="Close"
            type="button"
          >
            <X size={18} />
          </button>
          <div className="chat-history-modal-header">
            <h2 id="chat-history-dialog-title">Chat history</h2>
            <button
              aria-label="Refresh chat history"
              className="chat-icon-button"
              data-testid="chat-history-refresh-button"
              disabled={chatDisabled || pending || historyLoading}
              onClick={() => {
                void loadHistory();
              }}
              title="Refresh history"
              type="button"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {historyLoading ? (
            <span className="chat-history-status" data-testid="chat-history-loading">
              Loading
            </span>
          ) : null}
          {historyError ? (
            <p className="notice error chat-history-error" data-testid="chat-history-error">
              {historyError}
            </p>
          ) : null}
          {!historyLoading && !historyError && historyItems.length === 0 ? (
            <p className="notice chat-history-empty" data-testid="chat-history-empty">
              No history yet.
            </p>
          ) : null}
          <ChatHistoryList
            className="chat-history-list-modal"
            disabled={pending}
            historyItems={historyItems}
            onSelect={(item) => {
              if (pending) {
                return;
              }
              setSelectedHistoryId(item.id);
              setMessages(mapPrivateChatHistoryToThreadMessages([item], projectSlug));
              closeHistoryDialog();
            }}
            selectedHistoryId={selectedHistoryId}
          />
        </div>
      </dialog>
      <PrivateChatThread
        introMessage={selectedHistoryId === null ? projectChatIntroMessage(projectName) : undefined}
        messages={messages}
        resultTestId="chat-result"
      />
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="chat-question">Question</label>
        <div className="chat-input-row">
          <ChatQuestionTextarea
            disabled={chatDisabled || pending}
            id="chat-question"
            onChange={setQuestion}
            testId="chat-question-input"
            value={question}
          />
          <div className="chat-composer-actions">
            <button
              aria-label="Voice input"
              aria-pressed={speechInput.listening}
              className={`chat-icon-button${speechInput.listening ? ' chat-icon-button-active' : ''}`}
              data-testid="chat-mic-button"
              disabled={chatDisabled || pending || !speechInput.supported}
              onClick={speechInput.toggle}
              title={speechInput.supported ? 'Voice input' : 'Voice input is not supported'}
              type="button"
            >
              <Mic size={18} />
            </button>
            <button
              aria-label="Send"
              className="chat-icon-button chat-send-button"
              data-testid="chat-submit-button"
              disabled={chatDisabled || pending || !question.trim()}
              title="Send"
              type="submit"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </form>
      {chatDisabled ? (
        <p className="notice" data-testid="chat-disabled-notice">
          db_outside_business_hours
        </p>
      ) : null}
    </section>
  );
}

function ChatHistoryList({
  className,
  disabled,
  historyItems,
  onSelect,
  selectedHistoryId,
}: {
  readonly className?: string;
  readonly disabled: boolean;
  readonly historyItems: readonly PrivateChatHistoryItem[];
  readonly onSelect: (item: PrivateChatHistoryItem) => void;
  readonly selectedHistoryId: string | null;
}) {
  if (historyItems.length === 0) {
    return null;
  }

  return (
    <div className={classNames('chat-history-list', className)} data-testid="chat-history-list">
      {historyItems.map((item) => (
        <button
          aria-pressed={selectedHistoryId === item.id}
          className={`chat-history-item${selectedHistoryId === item.id ? ' chat-history-item-selected' : ''}`}
          data-testid={`chat-history-item-${item.id}`}
          disabled={disabled}
          key={item.id}
          onClick={() => onSelect(item)}
          type="button"
        >
          <span className="chat-history-item-time">{formatChatHistoryTime(item.createdAt)}</span>
          <span className="chat-history-item-question">{item.question}</span>
          <span className="chat-history-item-answer">{chatHistoryAnswerPreview(item.answer)}</span>
        </button>
      ))}
    </div>
  );
}

function classNames(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(' ');
}

function formatChatHistoryTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return CHAT_HISTORY_TIME_FORMATTER.format(date);
}

function chatHistoryAnswerPreview(answer: string): string {
  const normalized = answer.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 79)}...` : normalized;
}

export function PublicProjectChatPanel({
  projectName,
  projectSlug,
}: {
  readonly projectName: string;
  readonly projectSlug: string;
}) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatThreadMessage<PublicChatResponse>[]>([]);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const speechInput = useSpeechInput({
    disabled: pending || unavailable,
    setValue: setQuestion,
    value: question,
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || pending || unavailable) {
      return;
    }

    const nextMessages = appendUserMessage(messages, trimmedQuestion);
    const { messages: messagesWithPending, pendingId } = appendPendingAssistant(nextMessages);
    setMessages(messagesWithPending);
    setQuestion('');
    setPending(true);

    try {
      const result = await fetch(`/api/public/projects/${projectSlug}/chat`, {
        body: JSON.stringify({ question: trimmedQuestion }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const isJson = result.headers.get('content-type')?.includes('application/json') ?? false;
      const body = isJson
        ? ((await result.json()) as
            | PublicChatResponse
            | PublicProjectChatUnavailableResponse
            | ChatErrorResponse)
        : null;
      if (!result.ok) {
        if (isDbOutsideBusinessHoursResponse(body)) {
          setUnavailable(true);
        }
        throw new Error(chatErrorMessage(body, result.status));
      }
      if (!isPublicChatResponseBody(body)) {
        throw new Error('Public Chat API returned an invalid response.');
      }
      if (body.status === DB_OUTSIDE_BUSINESS_HOURS_CODE) {
        setUnavailable(true);
        throw new Error(DB_OUTSIDE_BUSINESS_HOURS_CODE);
      }
      setMessages((current) =>
        replacePendingAssistant(current, pendingId, {
          id: createMessageId('assistant'),
          role: 'assistant',
          response: publicSafeChatResponse(body, {
            projectSlug,
          }),
          status: 'complete',
        }),
      );
    } catch (caught) {
      const errorMessage = caught instanceof Error ? caught.message : String(caught);
      setMessages((current) =>
        replacePendingAssistant(current, pendingId, {
          error: errorMessage,
          id: createMessageId('assistant'),
          role: 'assistant',
          status: 'error',
        }),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="panel public-chat-panel public-project-chat-panel"
      data-testid="public-project-chat-panel"
    >
      <PublicChatThread
        introMessage={projectChatIntroMessage(projectName)}
        messages={messages}
        resultTestId="public-project-chat-result"
      />
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="public-project-chat-question">Question</label>
        <div className="chat-input-row">
          <ChatQuestionTextarea
            disabled={pending || unavailable}
            id="public-project-chat-question"
            onChange={setQuestion}
            testId="public-project-chat-question-input"
            value={question}
          />
          <div className="chat-composer-actions">
            <button
              aria-label="Voice input"
              aria-pressed={speechInput.listening}
              className={`chat-icon-button${speechInput.listening ? ' chat-icon-button-active' : ''}`}
              data-testid="public-project-chat-mic-button"
              disabled={pending || unavailable || !speechInput.supported}
              onClick={speechInput.toggle}
              title={speechInput.supported ? 'Voice input' : 'Voice input is not supported'}
              type="button"
            >
              <Mic size={18} />
            </button>
            <button
              aria-label="Send"
              className="chat-icon-button chat-send-button"
              data-testid="public-project-chat-submit-button"
              disabled={pending || unavailable || !question.trim()}
              title="Send"
              type="submit"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </form>
      {unavailable ? (
        <p className="notice" data-testid="public-project-chat-disabled-notice">
          db_outside_business_hours
        </p>
      ) : null}
    </section>
  );
}

function publicSafeChatResponse(
  response: PublicChatResponse,
  options: { readonly projectSlug: string },
): PublicChatResponse {
  return {
    answer: response.answer,
    ...(response.editing ? { editing: response.editing } : {}),
    projectSlug: options.projectSlug,
    reportId: response.reportId,
    sources: response.sources,
    status: response.status,
    toolCalls: response.toolCalls,
  };
}
