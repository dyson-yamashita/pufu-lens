'use client';

import { Send } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicChatResponse } from './chat';
import { ActionForm, PendingSubmitButton } from './form-buttons';
import { PufuReportViewer } from './pufu-report-viewer';
import type {
  PrivateReportJsonV1,
  PublicReportJsonV1,
  ReportListItem,
  ReportPeriod,
} from './report';

type ReportApiError = {
  readonly error?: { readonly code?: string; readonly message?: string };
};

type ReportGenerateAction = (formData: FormData) => Promise<void>;

const reportsUpdatedEvent = 'pufu:reports-updated';

export function ReportGenerateForm({
  action,
  defaultPeriod,
  projectSlug,
}: {
  readonly action: ReportGenerateAction;
  readonly defaultPeriod: ReportPeriod;
  readonly projectSlug: string;
}) {
  return (
    <ActionForm
      action={action}
      className="report-generate-form"
      onSuccess={() => {
        window.dispatchEvent(new CustomEvent(reportsUpdatedEvent, { detail: { projectSlug } }));
      }}
    >
      <input name="projectSlug" type="hidden" value={projectSlug} />
      <label>
        <span>Start</span>
        <input
          aria-label="Report period start"
          data-testid="reports-period-start-input"
          defaultValue={defaultPeriod.start}
          name="periodStart"
          required
          type="date"
        />
      </label>
      <label>
        <span>End</span>
        <input
          aria-label="Report period end"
          data-testid="reports-period-end-input"
          defaultValue={defaultPeriod.end}
          name="periodEnd"
          required
          type="date"
        />
      </label>
      <PendingSubmitButton
        className="primary-button report-generate-button"
        pendingLabel="Generating..."
        testId="reports-generate-button"
        title="Generate private report"
      >
        Generate Report
      </PendingSubmitButton>
    </ActionForm>
  );
}

export function ReportsList({ projectSlug }: { readonly projectSlug: string }) {
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const fetchIdRef = useRef(0);
  const [reports, setReports] = useState<readonly ReportListItem[]>([]);
  const [status, setStatus] = useState('loading');

  const loadReports = useCallback(() => {
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const fetchId = fetchIdRef.current + 1;
    fetchIdRef.current = fetchId;
    setReports([]);
    setStatus('loading');
    fetch(`/api/projects/${projectSlug}/reports`, { signal: abortController.signal })
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly error?: { readonly code?: string; readonly message?: string };
          readonly reports?: readonly ReportListItem[];
          readonly status?: string;
        };
        if (fetchId === fetchIdRef.current) {
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
        if (abortController.signal.aborted) {
          return;
        }
        if (fetchId === fetchIdRef.current) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      abortController.abort();
      if (fetchId === fetchIdRef.current) {
        fetchIdRef.current += 1;
      }
    };
  }, [projectSlug]);

  useEffect(() => loadReports(), [loadReports]);

  useEffect(() => {
    const handleReportsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ readonly projectSlug?: string }>).detail;
      if (!detail?.projectSlug || detail.projectSlug === projectSlug) {
        loadReports();
      }
    };
    window.addEventListener(reportsUpdatedEvent, handleReportsUpdated);
    return () => {
      window.removeEventListener(reportsUpdatedEvent, handleReportsUpdated);
    };
  }, [loadReports, projectSlug]);

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
