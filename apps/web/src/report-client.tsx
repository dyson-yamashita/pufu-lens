'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionForm, PendingSubmitButton } from './form-buttons';
import { PufuReportViewer } from './pufu-report-viewer';
import type {
  PrivateReportJsonV1,
  PrivateReportSource,
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
  const router = useRouter();
  const [report, setReport] = useState<PrivateReportJsonV1 | undefined>();
  const [status, setStatus] = useState('loading');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

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

  async function handleDelete() {
    if (!window.confirm('レポートが削除されますがよろしいですか')) {
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const response = await fetch(`/api/projects/${projectSlug}/reports/${reportId}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as ReportApiError & { readonly status?: string };
      if (!response.ok) {
        throw new Error(reportErrorStatus(body, response.status));
      }
      router.push(`/projects/${projectSlug}/reports`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

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
          {section.sources?.length ? (
            <div className="source-list">
              {section.sources.map((source) => (
                <article
                  className="source-chip"
                  data-testid={`report-source-${source.document_id}`}
                  key={source.document_id}
                >
                  <strong>{normalizePrivateReportSourceLabel(source.doc_type)}</strong>
                  {isPublicHttpUrl(source.canonical_uri) ? (
                    <a
                      href={source.canonical_uri}
                      rel="noreferrer"
                      target="_blank"
                      title={source.canonical_uri}
                    >
                      {privateReportSourceTitle(source)}
                    </a>
                  ) : (
                    <>
                      <span>{privateReportSourceTitle(source)}</span>
                      <small>{source.canonical_uri || source.document_id}</small>
                    </>
                  )}
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ))}
      <div className="report-delete-actions">
        <button
          className="report-delete-button"
          data-testid="report-delete-button"
          disabled={deleting}
          onClick={() => {
            void handleDelete();
          }}
          type="button"
        >
          {deleting ? 'Deleting...' : 'Delete Report'}
        </button>
        {deleteError ? (
          <p className="notice error" data-testid="report-delete-error">
            {deleteError}
          </p>
        ) : null}
      </div>
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
  const [report, setReport] = useState<PrivateReportJsonV1 | undefined>();
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    setReport(undefined);
    setStatus('loading');
    fetch(`/api/public/projects/${projectSlug}/reports/${reportId}`)
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
      <p className="notice error" data-testid="public-report-status">
        {status}
      </p>
    );
  }

  return (
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
            <dt>Generated</dt>
            <dd>{report.generated_at}</dd>
          </div>
        </dl>
      </header>
      <PufuReportViewer report={report} />
      {report.sections.map((section) => (
        <section
          className="report-section"
          data-testid={`public-report-section-${section.id}`}
          key={section.id}
        >
          <h3>{section.title}</h3>
          <p className="markdown-text">{section.markdown}</p>
          {section.metrics && Object.keys(section.metrics).length > 0 ? (
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
                <article
                  className="source-chip"
                  data-testid={`public-report-source-${source.document_id}`}
                  key={source.document_id}
                >
                  <strong>{normalizePrivateReportSourceLabel(source.doc_type)}</strong>
                  {isPublicHttpUrl(source.canonical_uri) ? (
                    <a
                      href={source.canonical_uri}
                      rel="noreferrer"
                      target="_blank"
                      title={source.canonical_uri}
                    >
                      {privateReportSourceTitle(source)}
                    </a>
                  ) : (
                    <>
                      <span>{privateReportSourceTitle(source)}</span>
                      <small>{source.canonical_uri || source.document_id}</small>
                    </>
                  )}
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </article>
  );
}

function reportErrorStatus(body: ReportApiError, status: number): string {
  return body.error?.code ?? body.error?.message ?? `http_${status}`;
}

function normalizePrivateReportSourceLabel(docType: string): string {
  if (docType === 'web_page') {
    return 'web';
  }
  return docType.replace(/_/g, ' ');
}

function privateReportSourceTitle(source: PrivateReportSource): string {
  if (source.title?.trim()) {
    return source.title.trim();
  }
  if (isPublicHttpUrl(source.canonical_uri)) {
    try {
      return new URL(source.canonical_uri).hostname;
    } catch {
      return source.document_id;
    }
  }
  return source.document_id;
}

function isPublicHttpUrl(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}
