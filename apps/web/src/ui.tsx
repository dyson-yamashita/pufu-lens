import {
  Activity,
  ArrowLeft,
  Database,
  FileSearch,
  FileText,
  GitBranch,
  Globe,
  HardDrive,
  Home,
  LogIn,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Network,
  RefreshCw,
  Settings,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { auth, signOut } from '../auth';
import type {
  DataSourceSummary,
  ParserProfileSummary,
  ProjectSummary,
  SourceStatus,
  SourceType,
} from './admin-data';
import { ActionForm, PendingSubmitButton } from './form-buttons';

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

export async function AppShell({
  project,
  active,
  children,
}: {
  readonly project?: ProjectSummary;
  readonly active?:
    | 'chat'
    | 'projects'
    | 'data-sources'
    | 'graph'
    | 'ingestion'
    | 'members'
    | 'overview'
    | 'parser-profiles'
    | 'reports'
    | 'settings';
  readonly children: React.ReactNode;
}) {
  const projectSlug = project?.slug;
  const session = await auth();
  const appRole = session?.user?.role;
  const canShowProjectNav = Boolean(projectSlug);
  const isGuest = !session?.user?.id;
  const navItems = (
    <>
      {projectSlug || session?.user?.id ? (
        <Link
          aria-current={active === 'projects' ? 'page' : undefined}
          className={navClass(active === 'projects')}
          href="/projects"
          data-testid="global-nav-projects"
        >
          <Database size={18} />
          Projects
        </Link>
      ) : null}
      {canShowProjectNav ? (
        <>
          <Link
            aria-current={active === 'overview' ? 'page' : undefined}
            className={navClass(active === 'overview')}
            href={`/projects/${projectSlug}`}
            data-testid="global-nav-overview"
          >
            <Home size={18} />
            Overview
          </Link>
          <Link
            aria-current={active === 'chat' ? 'page' : undefined}
            className={navClass(active === 'chat')}
            href={`/projects/${projectSlug}/chat`}
            data-testid="global-nav-chat"
          >
            <MessageSquare size={18} />
            Chat
          </Link>
          <Link
            aria-current={active === 'reports' ? 'page' : undefined}
            className={navClass(active === 'reports')}
            href={`/projects/${projectSlug}/reports`}
            data-testid="global-nav-reports"
          >
            <FileText size={18} />
            Reports
          </Link>
          {session?.user?.id ? (
            <Link
              aria-current={active === 'graph' ? 'page' : undefined}
              className={navClass(active === 'graph')}
              href={`/projects/${projectSlug}/graph`}
              data-testid="global-nav-graph"
            >
              <Network size={18} />
              Graph
            </Link>
          ) : null}
          {session?.user?.id ? (
            <>
              <Link
                aria-current={active === 'members' ? 'page' : undefined}
                className={navClass(active === 'members')}
                href={`/projects/${projectSlug}/members`}
                data-testid="global-nav-project-members"
              >
                <Users size={18} />
                Members
              </Link>
              <Link
                aria-current={active === 'data-sources' ? 'page' : undefined}
                className={navClass(active === 'data-sources')}
                href={`/projects/${projectSlug}/admin/data-sources`}
                data-testid="global-nav-data-sources"
              >
                <GitBranch size={18} />
                Sources
              </Link>
              <Link
                aria-current={active === 'ingestion' ? 'page' : undefined}
                className={navClass(active === 'ingestion')}
                href={`/projects/${projectSlug}/admin/ingestion`}
                data-testid="global-nav-ingestion"
              >
                <Activity size={18} />
                Ingestion
              </Link>
              <Link
                aria-current={active === 'parser-profiles' ? 'page' : undefined}
                className={navClass(active === 'parser-profiles')}
                href={`/projects/${projectSlug}/admin/parser-profiles`}
                data-testid="global-nav-parser-profiles"
              >
                <FileSearch size={18} />
                Parsers
              </Link>
              <Link
                aria-current={active === 'settings' ? 'page' : undefined}
                className={navClass(active === 'settings')}
                href={`/projects/${projectSlug}/admin/settings`}
                data-testid="global-nav-settings"
              >
                <Settings size={18} />
                Settings
              </Link>
            </>
          ) : null}
        </>
      ) : null}
      {!projectSlug && (appRole === 'admin' || appRole === 'member') ? (
        <Link
          aria-current={active === 'members' ? 'page' : undefined}
          className={navClass(active === 'members')}
          href="/members"
          data-testid="global-nav-members"
        >
          <Users size={18} />
          Accounts
        </Link>
      ) : null}
    </>
  );

  return (
    <div className={isGuest ? 'app-shell guest-app-shell' : 'app-shell'}>
      <aside
        className={isGuest ? 'global-nav guest-global-nav' : 'global-nav'}
        data-testid="global-nav"
      >
        {isGuest ? (
          <details className="guest-menu" data-testid="guest-menu" open>
            <summary className="guest-menu-toggle" data-testid="guest-menu-toggle">
              <Menu className="guest-menu-open-icon" size={22} />
              <ArrowLeft className="guest-menu-close-icon" size={22} />
              <span className="brand-mark">PL</span>
              <strong className="guest-brand-name">Pufu Lens</strong>
            </summary>
            <nav aria-label="Primary" className="guest-side-menu" data-testid="guest-side-menu">
              {navItems}
            </nav>
          </details>
        ) : (
          <details className="guest-menu" data-testid="app-menu" open>
            <summary className="guest-menu-toggle" data-testid="app-menu-toggle">
              <Menu className="guest-menu-open-icon" size={22} />
              <ArrowLeft className="guest-menu-close-icon" size={22} />
              <span className="brand-mark">PL</span>
              <strong className="guest-brand-name">Pufu Lens</strong>
            </summary>
            <nav aria-label="Primary" className="guest-side-menu" data-testid="app-side-menu">
              {navItems}
            </nav>
          </details>
        )}
        <div
          className={isGuest ? 'account-panel guest-account-panel' : 'account-panel'}
          data-testid="account-panel"
        >
          {session?.user?.id ? (
            <>
              <span className="account-identity" data-testid="account-identity">
                <strong>{session.user.name ?? session.user.email ?? 'Signed in'}</strong>
                <small>{appRole ?? session.user.role ?? 'member'}</small>
              </span>
              <form
                action={async () => {
                  'use server';
                  await signOut({ redirectTo: '/projects' });
                }}
              >
                <button className="nav-link-button" data-testid="logout-button" type="submit">
                  <LogOut size={18} />
                  Logout
                </button>
              </form>
            </>
          ) : (
            <Link className="nav-link-button" data-testid="login-link" href="/login">
              <LogIn size={18} />
              Login
            </Link>
          )}
        </div>
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

export function DataSourceTable({
  activeSourceId,
  activeType,
  projectSlug,
  sources,
}: {
  readonly activeSourceId?: string;
  readonly activeType?: SourceType;
  readonly projectSlug: string;
  readonly sources: readonly DataSourceSummary[];
}) {
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
            <tr
              className={activeSourceId === source.id ? 'selected-row' : undefined}
              key={source.id}
              data-testid={`data-source-row-${source.id}`}
            >
              <td>
                <Link
                  className="source-name source-name-link"
                  data-testid={`data-source-select-${source.id}`}
                  href={dataSourceDetailHref(projectSlug, source.id, activeType)}
                >
                  <SourceIcon sourceType={source.sourceType} />
                  <span>
                    <strong>{source.name}</strong>
                    <small>{sourceLabels[source.sourceType]}</small>
                  </span>
                </Link>
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

function dataSourceDetailHref(
  projectSlug: string,
  dataSourceId: string,
  activeType: SourceType | undefined,
): string {
  const params = new URLSearchParams();
  if (activeType) {
    params.set('sourceType', activeType);
  }
  params.set('dataSourceId', dataSourceId);
  return `/projects/${projectSlug}/admin/data-sources?${params.toString()}`;
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
      <ActionForm action={action}>
        <input name="projectSlug" type="hidden" value={projectSlug} />
        {dataSourceId ? <input name="dataSourceId" type="hidden" value={dataSourceId} /> : null}
        <PendingSubmitButton className="icon-button" testId={testId} title="Retry failed queue">
          <RefreshCw size={16} />
          Retry
        </PendingSubmitButton>
      </ActionForm>
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
        <ActionForm action={approveAction}>
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
        </ActionForm>
        <ActionForm action={rejectAction}>
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
        </ActionForm>
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
