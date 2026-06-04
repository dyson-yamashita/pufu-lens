'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { PrivateReportJsonV1, ReportListItem } from './report';

export function ReportsList({ projectSlug }: { readonly projectSlug: string }) {
  const [reports, setReports] = useState<readonly ReportListItem[]>([]);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectSlug}/reports`)
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly reports?: readonly ReportListItem[];
          readonly status?: string;
        };
        if (!cancelled) {
          setReports(body.reports ?? []);
          setStatus(body.status ?? `http_${response.status}`);
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
    fetch(`/api/projects/${projectSlug}/reports/${reportId}`)
      .then(async (response) => {
        const body = (await response.json()) as {
          readonly report?: PrivateReportJsonV1 | null;
          readonly status?: string;
        };
        if (!cancelled) {
          setReport(body.report ?? undefined);
          setStatus(body.status ?? `http_${response.status}`);
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
