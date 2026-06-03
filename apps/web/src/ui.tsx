import {
  Activity,
  Database,
  FileSearch,
  GitBranch,
  Globe,
  HardDrive,
  Mail,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import type {
  DataSourceSummary,
  ParserProfileSummary,
  ProjectSummary,
  SourceStatus,
  SourceType,
} from './admin-data';
import { PendingSubmitButton } from './form-buttons';

const sourceLabels: Record<SourceType, string> = {
  drive: 'Drive',
  github: 'GitHub',
  gmail: 'Gmail',
  web: 'Web',
};

const statusLabels: Record<SourceStatus, string> = {
  failed: 'Failed',
  healthy: 'Healthy',
  held: 'Held',
  syncing: 'Syncing',
};

export function AppShell({
  project,
  active,
  children,
}: {
  readonly project?: ProjectSummary;
  readonly active?: 'projects' | 'data-sources' | 'ingestion' | 'parser-profiles';
  readonly children: React.ReactNode;
}) {
  const projectSlug = project?.slug;

  return (
    <div className="app-shell">
      <aside className="global-nav" data-testid="global-nav">
        <Link className="brand" href="/projects" data-testid="global-nav-brand">
          <span className="brand-mark">PL</span>
          <span>
            <strong>Pufu Lens</strong>
            <small>Operations</small>
          </span>
        </Link>
        <nav aria-label="Primary">
          <Link
            className={navClass(active === 'projects')}
            href="/projects"
            data-testid="global-nav-projects"
          >
            <Database size={18} />
            Projects
          </Link>
          {projectSlug ? (
            <>
              <Link
                className={navClass(active === 'data-sources')}
                href={`/projects/${projectSlug}/admin/data-sources`}
                data-testid="global-nav-data-sources"
              >
                <GitBranch size={18} />
                Sources
              </Link>
              <Link
                className={navClass(active === 'ingestion')}
                href={`/projects/${projectSlug}/admin/ingestion`}
                data-testid="global-nav-ingestion"
              >
                <Activity size={18} />
                Ingestion
              </Link>
              <Link
                className={navClass(active === 'parser-profiles')}
                href={`/projects/${projectSlug}/admin/parser-profiles`}
                data-testid="global-nav-parser-profiles"
              >
                <FileSearch size={18} />
                Parsers
              </Link>
            </>
          ) : null}
        </nav>
      </aside>
      <main className="main-surface">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">Admin Console</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

export function MetricStrip({ project }: { readonly project: ProjectSummary }) {
  return (
    <section className="metric-strip" aria-label="Project ingestion metrics">
      <Metric label="Raw" value={project.rawCount} tone="neutral" />
      <Metric label="Queue" value={project.queueCount} tone="info" />
      <Metric
        label="Failed"
        value={project.failedCount}
        tone={project.failedCount > 0 ? 'danger' : 'neutral'}
      />
      <Metric
        label="Held"
        value={project.heldCount}
        tone={project.heldCount > 0 ? 'warning' : 'neutral'}
      />
    </section>
  );
}

export function StatusBadge({
  status,
}: {
  readonly status: SourceStatus | ParserProfileSummary['status'];
}) {
  return <span className={`status-badge status-${status}`}>{statusLabel(status)}</span>;
}

export function SourceIcon({ sourceType }: { readonly sourceType: SourceType }) {
  const Icon =
    sourceType === 'web'
      ? Globe
      : sourceType === 'github'
        ? GitBranch
        : sourceType === 'drive'
          ? HardDrive
          : Mail;
  return <Icon aria-hidden="true" size={18} />;
}

export function SourceTypeTabs({
  activeType,
  projectSlug,
}: {
  readonly activeType?: SourceType;
  readonly projectSlug: string;
}) {
  return (
    <div className="segmented-control" role="tablist" aria-label="Source type">
      <Link
        aria-selected={!activeType}
        className={!activeType ? 'selected' : ''}
        data-testid="source-type-all-tab"
        href={`/projects/${projectSlug}/admin/data-sources`}
        role="tab"
      >
        All
      </Link>
      {(['gmail', 'drive', 'github', 'web'] as const).map((sourceType) => (
        <Link
          aria-selected={activeType === sourceType}
          className={activeType === sourceType ? 'selected' : ''}
          data-testid={`source-type-${sourceType}-tab`}
          href={`/projects/${projectSlug}/admin/data-sources?sourceType=${sourceType}`}
          key={sourceType}
          role="tab"
        >
          {sourceLabels[sourceType]}
        </Link>
      ))}
    </div>
  );
}

export function DataSourceTable({ sources }: { readonly sources: readonly DataSourceSummary[] }) {
  return (
    <div className="table-frame">
      <table data-testid="data-source-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Status</th>
            <th>Queue</th>
            <th>Last checked</th>
            <th>Scope</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id} data-testid={`data-source-row-${source.id}`}>
              <td>
                <span className="source-name">
                  <SourceIcon sourceType={source.sourceType} />
                  <span>
                    <strong>{source.name}</strong>
                    <small>{sourceLabels[source.sourceType]}</small>
                  </span>
                </span>
              </td>
              <td>
                <StatusBadge status={source.status} />
              </td>
              <td>
                <span className="mono">
                  {source.queueCount} / failed {source.failedCount}
                </span>
              </td>
              <td>{source.lastChecked}</td>
              <td className="truncate">{source.scope}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RetryButton({
  action,
  dataSourceId,
  projectSlug,
  testId,
}: {
  readonly action?: (formData: FormData) => Promise<void>;
  readonly dataSourceId?: string;
  readonly projectSlug?: string;
  readonly testId: string;
}) {
  if (action && projectSlug) {
    return (
      <form action={action}>
        <input name="projectSlug" type="hidden" value={projectSlug} />
        {dataSourceId ? <input name="dataSourceId" type="hidden" value={dataSourceId} /> : null}
        <PendingSubmitButton className="icon-button" testId={testId} title="Retry failed queue">
          <RefreshCw size={16} />
          Retry
        </PendingSubmitButton>
      </form>
    );
  }

  return (
    <button className="icon-button" data-testid={testId} title="Retry failed queue" type="button">
      <RefreshCw size={16} />
      Retry
    </button>
  );
}

export function ParserActionButtons({
  approveAction,
  profile,
  projectSlug,
  rejectAction,
}: {
  readonly approveAction?: (formData: FormData) => Promise<void>;
  readonly profile: ParserProfileSummary;
  readonly projectSlug?: string;
  readonly rejectAction?: (formData: FormData) => Promise<void>;
}) {
  if (approveAction && rejectAction && projectSlug && profile.reviewVersionId) {
    return (
      <div className="action-row">
        <form action={approveAction}>
          <input name="projectSlug" type="hidden" value={projectSlug} />
          <input name="parserProfileId" type="hidden" value={profile.id} />
          <input name="parserVersionId" type="hidden" value={profile.reviewVersionId} />
          <PendingSubmitButton
            className="icon-button"
            disabled={profile.status !== 'review_requested'}
            testId={`parser-profile-approve-${profile.id}`}
            title="Approve parser version"
          >
            <ShieldCheck size={16} />
            Approve
          </PendingSubmitButton>
        </form>
        <form action={rejectAction}>
          <input name="projectSlug" type="hidden" value={projectSlug} />
          <input name="parserVersionId" type="hidden" value={profile.reviewVersionId} />
          <PendingSubmitButton
            className="icon-button muted"
            disabled={profile.status !== 'review_requested'}
            testId={`parser-profile-reject-${profile.id}`}
            title="Reject parser version"
          >
            <TriangleAlert size={16} />
            Reject
          </PendingSubmitButton>
        </form>
      </div>
    );
  }

  return (
    <div className="action-row">
      <button
        className="icon-button"
        data-testid={`parser-profile-approve-${profile.id}`}
        disabled={profile.status !== 'review_requested'}
        title="Approve parser version"
        type="button"
      >
        <ShieldCheck size={16} />
        Approve
      </button>
      <button
        className="icon-button muted"
        data-testid={`parser-profile-reject-${profile.id}`}
        disabled={profile.status !== 'review_requested'}
        title="Reject parser version"
        type="button"
      >
        <TriangleAlert size={16} />
        Reject
      </button>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: string;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function navClass(active: boolean) {
  return active ? 'nav-link active' : 'nav-link';
}

function statusLabel(status: SourceStatus | ParserProfileSummary['status']) {
  if (status in statusLabels) {
    return statusLabels[status as SourceStatus];
  }
  return status.replace('_', ' ');
}
