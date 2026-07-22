import Link from 'next/link';
import type { ProjectOverviewSnapshot } from './project-overview-data.ts';
import { PufuReportViewer } from './pufu-report-viewer.tsx';
import type { ProjectOverviewAssetV1, ProjectOverviewIssueV1 } from './report-project-overview.ts';

/**
 * Renders the latest scheduled report overview for a project page.
 */
export function ProjectOverviewSection({
  snapshot,
}: {
  readonly snapshot: ProjectOverviewSnapshot;
}) {
  const assets = dedupeOverviewAssets(snapshot.overview.assets);
  const issues = dedupeOverviewIssues(snapshot.overview.issues);

  return (
    <section className="panel project-overview-report" data-testid="project-overview-report">
      <div className="project-overview-report-meta" data-testid="project-overview-report-meta">
        <div>
          <p className="eyebrow">最新の定期レポート</p>
          <h2>プロジェクト状況</h2>
        </div>
        <dl className="project-overview-report-facts">
          <div>
            <dt>対象期間</dt>
            <dd data-testid="project-overview-period">
              {snapshot.period.start} – {snapshot.period.end}
            </dd>
          </div>
          <div>
            <dt>更新</dt>
            <dd data-testid="project-overview-updated-at">
              {formatOverviewTimestamp(snapshot.generatedAt)}
            </dd>
          </div>
        </dl>
      </div>
      <p className="project-overview-status-summary" data-testid="project-overview-status-summary">
        {snapshot.overview.status_summary}
      </p>
      {snapshot.showReportLink && snapshot.reportHref ? (
        <p className="project-overview-source-link">
          <Link data-testid="project-overview-source-report-link" href={snapshot.reportHref}>
            元レポートを見る
          </Link>
        </p>
      ) : null}
      <PufuReportViewer report={snapshot.pufuInput} />
      <div className="project-overview-columns" data-testid="project-overview-columns">
        <section className="project-overview-column" data-testid="project-overview-assets">
          <h3>アセット</h3>
          {assets.length > 0 ? (
            <ul className="project-overview-item-list">
              {assets.map((asset, index) => (
                <li data-testid={`project-overview-asset-${index}`} key={overviewAssetKey(asset)}>
                  <strong>{asset.title}</strong>
                  <p>{asset.description}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notice" data-testid="project-overview-assets-empty">
              この期間で整理されたアセットはまだありません。
            </p>
          )}
        </section>
        <section className="project-overview-column" data-testid="project-overview-issues">
          <h3>課題</h3>
          {issues.length > 0 ? (
            <ul className="project-overview-item-list">
              {issues.map((issue, index) => (
                <li data-testid={`project-overview-issue-${index}`} key={overviewIssueKey(issue)}>
                  <strong>{issue.title}</strong>
                  <p>{issue.description}</p>
                  <p className="project-overview-next-action">
                    <span>次のアクション</span>
                    {issue.next_action}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notice" data-testid="project-overview-issues-empty">
              この期間で整理された課題はまだありません。
            </p>
          )}
        </section>
      </div>
    </section>
  );
}

/**
 * Empty state when no scheduled overview is available yet.
 */
export function ProjectOverviewEmptyState() {
  return (
    <section className="panel project-overview-empty" data-testid="project-overview-empty">
      <h2>プロジェクト状況</h2>
      <p className="notice">
        定期レポートがまだないか、最新の定期レポートに公開向け概要が含まれていません。
      </p>
    </section>
  );
}

/**
 * Error state when overview loading fails without breaking the page shell.
 */
export function ProjectOverviewErrorState() {
  return (
    <section className="panel project-overview-error" data-testid="project-overview-error">
      <h2>プロジェクト状況</h2>
      <p className="notice">
        最新の定期レポート概要を読み込めませんでした。しばらくしてから再度お試しください。
      </p>
    </section>
  );
}

function dedupeOverviewAssets(
  assets: readonly ProjectOverviewAssetV1[],
): readonly ProjectOverviewAssetV1[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = overviewAssetKey(asset);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeOverviewIssues(
  issues: readonly ProjectOverviewIssueV1[],
): readonly ProjectOverviewIssueV1[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = overviewIssueKey(issue);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function overviewAssetKey(asset: ProjectOverviewAssetV1): string {
  return `${asset.title}\u0000${asset.description}`;
}

function overviewIssueKey(issue: ProjectOverviewIssueV1): string {
  return `${issue.title}\u0000${issue.description}\u0000${issue.next_action}`;
}

function formatOverviewTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  });
}
