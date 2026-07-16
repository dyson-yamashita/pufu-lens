'use client';

import domToImage from 'dom-to-image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CustomReportLayoutRenderer, StandardReportSections } from './custom-report-renderer';
import { ActionForm, PendingSubmitButton } from './form-buttons';
import type { PrivateReportJsonV1, ReportListItem, ReportPeriod } from './report';
import { formatReportSummaryPreview } from './report-summary';

type ReportApiError = {
  readonly error?: { readonly code?: string; readonly message?: string };
};

type ReportGenerateAction = (formData: FormData) => Promise<void>;

const reportsUpdatedEvent = 'pufu:reports-updated';

/**
 * Renders the report generation form.
 *
 * @param action - The form submission action.
 * @param customTemplates - Available report templates to include in the format selector.
 * @param defaultPeriod - The initial report period.
 * @param projectSlug - The project identifier submitted with the form.
 */
export function ReportGenerateForm({
  action,
  customTemplates = [],
  defaultPeriod,
  projectSlug,
}: {
  readonly action: ReportGenerateAction;
  readonly customTemplates?: readonly {
    readonly id: string;
    readonly name: string;
    readonly templateVersion: number;
  }[];
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
        <span>Format</span>
        <select
          aria-label="Report format"
          data-testid="reports-template-select"
          defaultValue=""
          name="customTemplateId"
        >
          <option value="">Standard report</option>
          {customTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} v{template.templateVersion}
            </option>
          ))}
        </select>
      </label>
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
                <small className="block-muted">
                  {formatReportSummaryPreview(report.summary ?? '')}
                </small>
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

/**
 * Displays a private report and provides PDF download and deletion actions.
 *
 * @param projectSlug - The project slug that identifies the report source
 * @param reportId - The report identifier
 */
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
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [pdfDownloadError, setPdfDownloadError] = useState<string | undefined>();

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

  async function handlePdfDownload() {
    setPdfDownloading(true);
    setPdfDownloadError(undefined);
    try {
      const result = await downloadReportPdf({
        fallbackFileName: `${projectSlug}-${reportId}.pdf`,
        url: `/api/projects/${projectSlug}/reports/${reportId}/pdf`,
      });
      if (!result.ok) {
        setPdfDownloadError(result.message);
      }
    } catch (error) {
      setPdfDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setPdfDownloading(false);
    }
  }

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
      const body = (await response.json()) as ReportApiError;
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
        <button
          className="secondary-button"
          data-testid="report-pdf-download-button"
          disabled={pdfDownloading}
          onClick={() => {
            void handlePdfDownload();
          }}
          type="button"
        >
          {pdfDownloading ? 'Downloading PDF...' : 'Download PDF'}
        </button>
        {pdfDownloadError ? (
          <p className="notice error" data-testid="report-pdf-download-error">
            {pdfDownloadError}
          </p>
        ) : null}
      </header>
      {report.custom_layout ? (
        <CustomReportLayoutRenderer report={report} snapshot={report.custom_layout} />
      ) : (
        <StandardReportSections report={report} />
      )}
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

/**
 * Displays a public report and lets the user download it as a PDF.
 *
 * @param projectSlug - The project identifier used to load the report.
 * @param reportId - The report identifier used to load the report.
 */
export function PublicReportDocument({
  projectSlug,
  reportId,
}: {
  readonly projectSlug: string;
  readonly reportId: string;
}) {
  const [report, setReport] = useState<PrivateReportJsonV1 | undefined>();
  const [status, setStatus] = useState('loading');
  const [pdfDownloading, setPdfDownloading] = useState(false);
  const [pdfDownloadError, setPdfDownloadError] = useState<string | undefined>();

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

  async function handlePdfDownload() {
    setPdfDownloading(true);
    setPdfDownloadError(undefined);
    try {
      const result = await downloadReportPdf({
        fallbackFileName: `${projectSlug}-${reportId}.pdf`,
        url: `/api/public/projects/${projectSlug}/reports/${reportId}/pdf`,
      });
      if (!result.ok) {
        setPdfDownloadError(result.message);
      }
    } catch (error) {
      setPdfDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setPdfDownloading(false);
    }
  }

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
        <button
          className="secondary-button"
          data-testid="public-report-pdf-download-button"
          disabled={pdfDownloading}
          onClick={() => {
            void handlePdfDownload();
          }}
          type="button"
        >
          {pdfDownloading ? 'Downloading PDF...' : 'Download PDF'}
        </button>
        {pdfDownloadError ? (
          <p className="notice error" data-testid="public-report-pdf-download-error">
            {pdfDownloadError}
          </p>
        ) : null}
      </header>
      {report.custom_layout ? (
        <CustomReportLayoutRenderer report={report} snapshot={report.custom_layout} />
      ) : (
        <StandardReportSections publicView report={report} />
      )}
    </article>
  );
}

/**
 * Converts a report API error response into a status string.
 *
 * @param body - The parsed error response body.
 * @param status - The HTTP status code.
 * @returns The error code, error message, or `http_<status>`.
 */
function reportErrorStatus(body: ReportApiError, status: number): string {
  return body.error?.code ?? body.error?.message ?? `http_${status}`;
}

function mapPdfDownloadErrorMessage(code: string): string {
  switch (code) {
    case 'auth_required':
      return 'PDF をダウンロードするにはログインが必要です。';
    case 'project_access_denied':
      return 'このレポートの PDF をダウンロードする権限がありません。';
    case 'report_not_found':
    case 'public_report_not_found':
      return 'レポートが見つかりません。';
    case 'report_pdf_internal_error':
    case 'public_report_pdf_internal_error':
    case 'public_report_internal_error':
      return 'PDF の生成中にエラーが発生しました。時間をおいて再度お試しください。';
    default:
      return code.startsWith('http_')
        ? 'PDF のダウンロードに失敗しました。'
        : 'PDF のダウンロードに失敗しました。';
  }
}

/**
 * Downloads a report PDF and starts a browser file download.
 *
 * @param input.fallbackFileName - File name to use when the response does not provide one.
 * @param input.url - PDF endpoint to request.
 * @returns `{ ok: true }` when the download is started, or `{ ok: false, message }` when the request fails.
 */
async function downloadReportPdf(input: {
  readonly fallbackFileName: string;
  readonly url: string;
}): Promise<{ readonly ok: true } | { readonly message: string; readonly ok: false }> {
  const pufuImageDataUrl = await capturePufuEditorImage();
  const response = await fetch(input.url, {
    body: JSON.stringify({ pufuImageDataUrl }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    let message = `http_${response.status}`;
    try {
      const body = (await response.json()) as ReportApiError;
      message = mapPdfDownloadErrorMessage(reportErrorStatus(body, response.status));
    } catch {
      // Keep the HTTP status fallback when the error body is not JSON.
    }
    return { message, ok: false };
  }
  const blob = await response.blob();
  const fileName =
    parseContentDispositionFileName(response.headers.get('Content-Disposition')) ??
    input.fallbackFileName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 0);
  return { ok: true };
}

async function capturePufuEditorImage(): Promise<string | undefined> {
  const score = document.querySelector<HTMLElement>(
    '[data-testid="pufu-report-score"] [role="score"]',
  );
  if (!score) return undefined;
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  return domToImage.toPng(score, { bgcolor: 'white', quality: 1 });
}

/**
 * Extracts a filename from a Content-Disposition header value.
 *
 * @param value - The header value to inspect
 * @returns The quoted filename if present, otherwise `undefined`
 */
function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /filename="([^"]+)"/u.exec(value);
  return match?.[1];
}
