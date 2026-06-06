'use client';

import { Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { PublicChatResponse } from './chat';
import { PufuReportViewer } from './pufu-report-viewer';
import type { PrivateReportJsonV1, PublicReportJsonV1, ReportListItem } from './report';

type ReportApiError = {
  readonly error?: { readonly code?: string; readonly message?: string };
};

export function ReportsList({ projectSlug }: { readonly projectSlug: string }) {
  const [reports, setReports] = useState<readonly ReportListItem[]>([]);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    setReports([]);
    setStatus('loading');
    fetch(`/api/projects/${projectSlug}/reports`)
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly error?: { readonly code?: string; readonly message?: string };
          readonly reports?: readonly ReportListItem[];
          readonly status?: string;
        };
        if (!cancelled) {
          if (!response.ok && body.error) {
            setReports([]);
            setStatus(reportErrorStatus(body, response.status));
          } else {
            setReports(body.reports ?? []);
            setStatus(body.status ?? `http_${response.status}`);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  if (status === 'loading') {
    return <p className="notice">loading</p>;
  }
  if (status !== 'ok') {
    return (
      <p className="notice error" data-testid="reports-status">
        {status}
      </p>
    );
  }
  if (reports.length === 0) {
    return (
      <p className="notice" data-testid="reports-empty">
        report はまだありません。
      </p>
    );
  }

  return (
    <div className="table-frame">
      <table data-testid="reports-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Period</th>
            <th>Schema</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr data-testid={`report-row-${report.id}`} key={report.id}>
              <td>
                <Link href={`/projects/${projectSlug}/reports/${report.id}`}>{report.title}</Link>
                <small className="block-muted">{report.summary}</small>
              </td>
              <td className="mono">
                {report.period.start} / {report.period.end}
              </td>
              <td>{report.schemaVersion}</td>
              <td>{report.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportDocument({
  projectSlug,
  reportId,
}: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  const [report, setReport] = useState<PrivateReportJsonV1 | undefined>();
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    setReport(undefined);
    setStatus('loading');
    fetch(`/api/projects/${projectSlug}/reports/${reportId}`)
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly error?: { readonly code?: string; readonly message?: string };
          readonly report?: PrivateReportJsonV1 | null;
          readonly status?: string;
        };
        if (!cancelled) {
          if (!response.ok && body.error) {
            setReport(undefined);
            setStatus(reportErrorStatus(body, response.status));
          } else {
            setReport(body.report ?? undefined);
            setStatus(body.status ?? `http_${response.status}`);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, reportId]);

  if (status === 'loading') {
    return <p className="notice">loading</p>;
  }
  if (!report || status !== 'ok') {
    return (
      <p className="notice error" data-testid="report-status">
        {status}
      </p>
    );
  }

  return (
    <article className="report-document" data-testid="report-document">
      <header className="report-document-header">
        <p className="eyebrow">{report.schema_version}</p>
        <h2>{report.title}</h2>
        <p>{report.summary}</p>
        <dl className="detail-list">
          <div>
            <dt>Period</dt>
            <dd>
              {report.period.start} / {report.period.end}
            </dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{report.generated_at}</dd>
          </div>
        </dl>
      </header>
      <PufuReportViewer report={report} />
      {report.sections.map((section) => (
        <section
          className="report-section"
          data-testid={`report-section-${section.id}`}
          key={section.id}
        >
          <h3>{section.title}</h3>
          <p className="markdown-text">{section.markdown}</p>
          {section.metrics ? (
            <div className="metric-strip compact">
              {Object.entries(section.metrics).map(([name, value]) => (
                <div className="metric" key={name}>
                  <span>{name}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          ) : null}
          {section.sources?.length ? (
            <div className="source-list">
              {section.sources.map((source) => (
                <article className="source-chip" key={source.document_id}>
                  <strong>{source.doc_type}</strong>
                  <span>{source.snippet}</span>
                  <small>{source.canonical_uri || source.document_id}</small>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </article>
  );
}

export function PublicReportDocument({
  projectSlug,
  reportId,
}: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  const [report, setReport] = useState<PublicReportJsonV1 | undefined>();
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    setReport(undefined);
    setStatus('loading');
    fetch(`/api/public/projects/${projectSlug}/reports/${reportId}`)
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly error?: { readonly code?: string; readonly message?: string };
          readonly report?: PublicReportJsonV1 | null;
          readonly status?: string;
        };
        if (!cancelled) {
          if (!response.ok && body.error) {
            setReport(undefined);
            setStatus(reportErrorStatus(body, response.status));
          } else {
            setReport(body.report ?? undefined);
            setStatus(body.status ?? `http_${response.status}`);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, reportId]);

  if (status === 'loading') {
    return <p className="notice">loading</p>;
  }
  if (!report || status !== 'ok') {
    return (
      <p className="notice error" data-testid="public-report-status">
        {status}
      </p>
    );
  }

  return (
    <>
      <article
        className="report-document public-report-document"
        data-testid="public-report-document"
      >
        <header className="report-document-header">
          <p className="eyebrow">{report.schema_version}</p>
          <h2>{report.title}</h2>
          <p>{report.summary}</p>
          <dl className="detail-list">
            <div>
              <dt>Period</dt>
              <dd>
                {report.period.start} / {report.period.end}
              </dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{report.published_at}</dd>
            </div>
          </dl>
        </header>
        {report.sections.map((section) => (
          <section
            className="report-section"
            data-testid={`public-report-section-${section.id}`}
            key={section.id}
          >
            <h3>{section.title}</h3>
            <p className="markdown-text">{section.markdown}</p>
            {section.metrics ? (
              <div className="metric-strip compact">
                {Object.entries(section.metrics).map(([name, value]) => (
                  <div className="metric" key={name}>
                    <span>{name}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            ) : null}
            {section.sources?.length ? (
              <div className="source-list">
                {section.sources.map((source) => (
                  <article className="source-chip" key={source.public_source_id}>
                    <strong>{source.public_source_id}</strong>
                    <span>{source.label}</span>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </article>
      <PublicReportChatPanel projectSlug={projectSlug} reportId={reportId} />
    </>
  );
}

function PublicReportChatPanel({
  projectSlug,
  reportId,
}: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  const [question, setQuestion] = useState('');
  const [response, setResponse] = useState<PublicChatResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    setResponse(undefined);
    try {
      const result = await fetch(`/api/public/projects/${projectSlug}/reports/${reportId}/chat`, {
        body: JSON.stringify({ question: trimmedQuestion }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const isJson = result.headers.get('content-type')?.includes('application/json') ?? false;
      const body = isJson
        ? ((await result.json()) as PublicChatResponse | ReportApiError)
        : undefined;
      if (!result.ok) {
        const errorBody = body && 'error' in body ? body : {};
        throw new Error(reportErrorStatus(errorBody, result.status));
      }
      if (!body || !('status' in body)) {
        throw new Error('Public Chat API returned an invalid response.');
      }
      setResponse(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel public-chat-panel" data-testid="public-chat-panel">
      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="public-chat-question">Public report question</label>
        <div className="chat-input-row">
          <textarea
            data-testid="public-chat-question-input"
            disabled={pending}
            id="public-chat-question"
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            value={question}
          />
          <button
            className="primary-button"
            data-testid="public-chat-submit-button"
            disabled={pending || !question.trim()}
            type="submit"
          >
            <Send size={16} />
            Send
          </button>
        </div>
      </form>
      {error ? (
        <p className="notice error" data-testid="public-chat-error">
          {error}
        </p>
      ) : null}
      {response ? (
        <div className="chat-result" data-testid="public-chat-result">
          <h2>Answer</h2>
          <p>{response.answer}</p>
          <h3>Public Sources</h3>
          <div className="source-list">
            {response.sources.map((source) => (
              <article className="source-chip" key={`${source.sectionId}-${source.publicSourceId}`}>
                <strong>{source.publicSourceId}</strong>
                <span>{source.sectionId}</span>
                <small>{source.label}</small>
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

function reportErrorStatus(body: ReportApiError, status: number): string {
  return body.error?.code ?? body.error?.message ?? `http_${status}`;
}
