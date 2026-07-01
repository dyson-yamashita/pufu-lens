'use client';

import { ArrowUp, Mic, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ChatErrorResponse,
  type ChatResponse,
  isDbOutsideBusinessHoursError,
  type PrivateChatHistoryListResponse,
  type PublicChatResponse,
  resolvePrivateChatHistoryApplyAction,
} from './chat';
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

export function ChatPanel({
  disabled,
  projectSlug,
}: {
  readonly disabled: boolean;
  readonly projectSlug: string;
}) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatThreadMessage<ChatResponse>[]>([]);
  const [pending, setPending] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequestSeqRef = useRef(0);
  const pendingRef = useRef(false);
  pendingRef.current = pending;

  useEffect(() => {
    historyRequestSeqRef.current += 1;
    setMessages([]);
    setHistoryError(null);
    setHistoryLoading(false);
    void projectSlug;
  }, [projectSlug]);
  const speechInput = useSpeechInput({
    disabled: disabled || pending,
    setValue: setQuestion,
    value: question,
  });

  const loadHistory = useCallback(
    async (options?: { readonly refresh?: boolean }) => {
      if (disabled) {
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
          if (isDbOutsideBusinessHoursError(body && 'error' in body ? body : null)) {
            return;
          }
          throw new Error(chatErrorMessage(body && 'error' in body ? body : null, result.status));
        }
        if (!body || !('items' in body)) {
          throw new Error('Chat history API returned an invalid response.');
        }
        if (requestSeq !== historyRequestSeqRef.current) {
          return;
        }
        const historyMessages = mapPrivateChatHistoryToThreadMessages(body.items, projectSlug);
        setMessages((current) => {
          const action = resolvePrivateChatHistoryApplyAction({
            currentMessageCount: current.length,
            hasPendingAssistantMessage: current.some(
              (message) => message.role === 'assistant' && message.status === 'pending',
            ),
            hasPendingRequest: pendingRef.current,
            refresh: options?.refresh ?? false,
          });
          return action === 'apply' ? historyMessages : current;
        });
      } catch (caught) {
        if (requestSeq === historyRequestSeqRef.current) {
          setHistoryError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (requestSeq === historyRequestSeqRef.current) {
          setHistoryLoading(false);
        }
      }
    },
    [disabled, projectSlug],
  );

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || disabled || pending) {
      return;
    }

    const nextMessages = appendUserMessage(messages, trimmedQuestion);
    const { messages: messagesWithPending, pendingId } = appendPendingAssistant(nextMessages);
    setMessages(messagesWithPending);
    setQuestion('');
    setPending(true);

    try {
      const result = await fetch(`/api/projects/${projectSlug}/chat`, {
        body: JSON.stringify({ question: trimmedQuestion }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const isJson = result.headers.get('content-type')?.includes('application/json') ?? false;
      const body = isJson ? ((await result.json()) as ChatResponse | ChatErrorResponse) : null;
      if (!result.ok) {
        throw new Error(chatErrorMessage(body, result.status));
      }
      if (!body || !('status' in body)) {
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
    }
  }

  return (
    <section className="panel chat-panel" data-testid="chat-panel">
      <div className="chat-history-header" data-testid="chat-history-header">
        <div className="chat-history-controls">
          <button
            aria-label="Refresh chat history"
            className="chat-icon-button"
            data-testid="chat-history-refresh-button"
            disabled={disabled || pending || historyLoading}
            onClick={() => {
              void loadHistory({ refresh: true });
            }}
            title="Refresh history"
            type="button"
          >
            <RefreshCw size={16} />
          </button>
          {historyLoading ? (
            <span className="chat-history-status" data-testid="chat-history-loading">
              Loading
            </span>
          ) : null}
        </div>
        {historyError ? (
          <p className="notice error chat-history-error" data-testid="chat-history-error">
            {historyError}
          </p>
        ) : null}
      </div>
      <PrivateChatThread messages={messages} resultTestId="chat-result" />
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="chat-question">Question</label>
        <div className="chat-input-row">
          <textarea
            data-testid="chat-question-input"
            disabled={disabled || pending}
            id="chat-question"
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            value={question}
          />
          <div className="chat-composer-actions">
            <button
              aria-label="Voice input"
              aria-pressed={speechInput.listening}
              className={`chat-icon-button${speechInput.listening ? ' chat-icon-button-active' : ''}`}
              data-testid="chat-mic-button"
              disabled={disabled || pending || !speechInput.supported}
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
              disabled={disabled || pending || !question.trim()}
              title="Send"
              type="submit"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </form>
      {disabled ? (
        <p className="notice" data-testid="chat-disabled-notice">
          db_outside_business_hours
        </p>
      ) : null}
    </section>
  );
}

export function PublicProjectChatPanel({ projectSlug }: { readonly projectSlug: string }) {
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
        if (body && 'status' in body && body.status === 'db_outside_business_hours') {
          setUnavailable(true);
        }
        throw new Error(chatErrorMessage(body, result.status));
      }
      if (!body || !('status' in body)) {
        throw new Error('Public Chat API returned an invalid response.');
      }
      if (body.status === 'db_outside_business_hours') {
        setUnavailable(true);
        throw new Error('db_outside_business_hours');
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
      if (errorMessage === 'db_outside_business_hours') {
        setUnavailable(true);
      }
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
      <PublicChatThread messages={messages} resultTestId="public-project-chat-result" />
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="public-project-chat-question">Question</label>
        <div className="chat-input-row">
          <textarea
            data-testid="public-project-chat-question-input"
            disabled={pending || unavailable}
            id="public-project-chat-question"
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
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

type PublicProjectChatUnavailableResponse = {
  readonly answer: 'db_outside_business_hours';
  readonly projectSlug: string;
  readonly reportId: string;
  readonly sources: readonly [];
  readonly status: 'db_outside_business_hours';
  readonly toolCalls: readonly [];
};

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

function chatErrorMessage(
  body:
    | ChatResponse
    | PublicChatResponse
    | PublicProjectChatUnavailableResponse
    | ChatErrorResponse
    | null,
  status: number,
): string {
  if (body && 'error' in body && body.error) {
    return typeof body.error === 'string'
      ? body.error
      : (body.error.message ?? body.error.code ?? `HTTP ${status}`);
  }
  if (body && 'answer' in body && body.answer) {
    return body.answer;
  }
  return `HTTP ${status}`;
}
