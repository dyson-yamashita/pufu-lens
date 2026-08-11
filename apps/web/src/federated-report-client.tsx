'use client';

import { useEffect, useState } from 'react';
import type { FederatedReportApiItem } from './federated-report-api';
import { parseFederatedReportsApiResponse } from './federated-report-response';

type FederatedReportsListProps = {
  readonly projectSlug: string;
};

function formatPublishedAt(value: string | null): string {
  if (!value) {
    return '公開時刻不明';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '公開時刻不明';
  }
  return date.toLocaleString('ja-JP');
}

/**
 * Renders federated inbound reports fetched from the project API.
 *
 * @param props - Project slug used to load federated reports.
 */
export function FederatedReportsList({ projectSlug }: FederatedReportsListProps) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; response: ReturnType<typeof parseFederatedReportsApiResponse> & { ok: true } }
    | { kind: 'error' }
  >({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectSlug)}/federated-reports`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          setState({ kind: 'error' });
          return;
        }
        const body: unknown = await response.json();
        const parsed = parseFederatedReportsApiResponse(body);
        if (!parsed.ok) {
          setState({ kind: 'error' });
          return;
        }
        setState({ kind: 'ok', response: parsed });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setState({ kind: 'error' });
      }
    }
    void load();
    return () => controller.abort();
  }, [projectSlug]);

  if (state.kind === 'loading') {
    return (
      <p className="notice" data-testid="federated-reports-loading">
        外部レポートを読み込み中です。
      </p>
    );
  }

  if (state.kind === 'error') {
    return (
      <p className="notice error" data-testid="federated-reports-error" role="alert">
        外部レポートの取得に失敗しました。
      </p>
    );
  }

  const { response } = state.response;
  if (response.status === 'blocked') {
    return (
      <p className="notice" data-testid="federated-reports-blocked" role="status">
        現在のドメインブロック設定により、表示できる外部レポートがありません。
      </p>
    );
  }

  if (response.reports.length === 0) {
    return (
      <p className="notice" data-testid="federated-reports-empty">
        外部レポートはまだありません。
      </p>
    );
  }

  return (
    <div className="federated-reports-list" data-testid="federated-reports-list">
      {response.blockedCount > 0 ? (
        <p className="notice" data-testid="federated-reports-mixed-blocked" role="status">
          {response.blockedCount} 件の外部レポートは現在のドメインブロック設定により非表示です。
        </p>
      ) : null}
      <div className="federated-reports-items">
        {response.reports.map((report) => (
          <FederatedReportCard key={`${report.originalUrl}-${report.title}`} report={report} />
        ))}
      </div>
    </div>
  );
}

function FederatedReportCard({ report }: { readonly report: FederatedReportApiItem }) {
  return (
    <article className="federated-report-card" data-testid="federated-report-card">
      <header className="federated-report-card-header">
        <h3>{report.title}</h3>
        <p className="mono" data-testid="federated-report-source-actor">
          {report.sourceActor}
        </p>
        <p className="mono" data-testid="federated-report-domain">
          {report.domain}
        </p>
        <p data-testid="federated-report-published-at">{formatPublishedAt(report.publishedAt)}</p>
      </header>
      {report.summaryHtmlSanitized ? (
        <div
          className="federated-report-summary"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: summaryHtmlSanitized is allowlisted at ingestion, API, and client parser layers.
          dangerouslySetInnerHTML={{ __html: report.summaryHtmlSanitized }}
          data-testid="federated-report-summary"
        />
      ) : null}
      <a
        className="button-link"
        data-testid="federated-report-original-link"
        href={report.originalUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        元レポートを開く
      </a>
    </article>
  );
}
