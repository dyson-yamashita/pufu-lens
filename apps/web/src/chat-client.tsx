'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';
import type { ChatResponse } from './chat';

export function ChatPanel({
  disabled,
  projectSlug,
}: {
  readonly disabled: boolean;
  readonly projectSlug: string;
}) {
  const [question, setQuestion] = useState('');
  const [response, setResponse] = useState<ChatResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || disabled || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const result = await fetch(`/api/projects/${projectSlug}/chat`, {
        body: JSON.stringify({ question: trimmedQuestion }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const isJson = result.headers.get('content-type')?.includes('application/json') ?? false;
      const body = isJson ? ((await result.json()) as ChatResponse | { error?: string }) : null;
      if (!result.ok) {
        throw new Error(chatErrorMessage(body, result.status));
      }
      if (!body || !('status' in body)) {
        throw new Error('Chat API returned an invalid response.');
      }
      setResponse(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel chat-panel" data-testid="chat-panel">
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
          <button
            className="primary-button"
            data-testid="chat-submit-button"
            disabled={disabled || pending || !question.trim()}
            type="submit"
          >
            <Send size={16} />
            Send
          </button>
        </div>
      </form>
      {disabled ? (
        <p className="notice" data-testid="chat-disabled-notice">
          db_outside_business_hours
        </p>
      ) : null}
      {error ? (
        <p className="notice error" data-testid="chat-error">
          {error}
        </p>
      ) : null}
      {response ? (
        <div className="chat-result" data-testid="chat-result">
          <h2>Answer</h2>
          <p>{response.answer}</p>
          <h3>Sources</h3>
          <div className="source-list">
            {response.sources.map((source) => (
              <article className="source-chip" key={source.documentId}>
                <strong>{source.title}</strong>
                <span>{source.docType}</span>
                <small>{source.canonicalUri || source.documentId}</small>
              </article>
            ))}
          </div>
          <h3>Tool Calls</h3>
          <div className="tool-call-list">
            {response.toolCalls.map((toolCall) => (
              <span className="status-badge" key={toolCall.name}>
                {toolCall.name}: {toolCall.resultCount}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function chatErrorMessage(body: ChatResponse | { error?: string } | null, status: number): string {
  if (body && 'error' in body && body.error) {
    return body.error;
  }
  if (body && 'answer' in body && body.answer) {
    return body.answer;
  }
  return `HTTP ${status}`;
}
