'use client';

import { ArrowUp, Mic } from 'lucide-react';
import { useState } from 'react';
import type { ChatResponse, PublicChatResponse } from './chat';
import {
  appendPendingAssistant,
  appendUserMessage,
  type ChatThreadMessage,
  createMessageId,
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
  const speechInput = useSpeechInput({
    disabled: disabled || pending,
    setValue: setQuestion,
    value: question,
  });

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
  const speechInput = useSpeechInput({
    disabled: pending,
    setValue: setQuestion,
    value: question,
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || pending) {
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
        ? ((await result.json()) as PublicChatResponse | ChatErrorResponse)
        : null;
      if (!result.ok) {
        throw new Error(chatErrorMessage(body, result.status));
      }
      if (!body || !('status' in body)) {
        throw new Error('Public Chat API returned an invalid response.');
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
            disabled={pending}
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
              disabled={pending || !speechInput.supported}
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
              disabled={pending || !question.trim()}
              title="Send"
              type="submit"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

type ChatErrorResponse = {
  readonly error?: string | { readonly code?: string; readonly message?: string };
};

function chatErrorMessage(
  body: ChatResponse | PublicChatResponse | ChatErrorResponse | null,
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
