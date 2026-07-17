'use client';

import { ActionForm, PendingSubmitButton } from './form-buttons';
import {
  DEFAULT_REPORT_SCHEDULE_RUN_TIME,
  formatReportScheduleTimestamp,
  type ProjectReportScheduleSettingsView,
  reportScheduleFrequencyLabel,
  reportSchedulePeriodRunStatusLabel,
} from './report-schedule-settings.ts';
import type { ReportScheduleFrequency } from './report-schedules.ts';

type ReportScheduleUpdateAction = (formData: FormData) => Promise<void>;

const FREQUENCY_OPTIONS: readonly ReportScheduleFrequency[] = [
  'none',
  'weekly',
  'monthly',
  'annually',
];

/**
 * Renders project report schedule settings and recent execution state for members.
 */
export function ReportSchedulePanel({
  canManage,
  projectSlug,
  settings,
  updateAction,
}: {
  readonly canManage: boolean;
  readonly projectSlug: string;
  readonly settings: ProjectReportScheduleSettingsView;
  readonly updateAction: ReportScheduleUpdateAction;
}) {
  return (
    <section className="panel report-schedule-panel" data-testid="report-schedule-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Schedule</p>
          <h2>定期レポート設定</h2>
        </div>
      </div>
      <p
        className="notice report-schedule-timezone-note"
        data-testid="report-schedule-timezone-note"
      >
        定期実行は {settings.timezone} の {settings.runTime || DEFAULT_REPORT_SCHEDULE_RUN_TIME}{' '}
        を基準にします。初回の有効化で同周期の定期レポートがまだない場合のみ、完了済み過去期間の
        backfill を非同期で enqueue します。同じ周期の再保存や周期変更では即時 backfill
        は行わず、次回 定期実行のみ更新します。
      </p>
      {canManage ? (
        <ActionForm
          action={updateAction}
          className="report-schedule-form"
          testId="report-schedule-form"
        >
          <input name="projectSlug" type="hidden" value={projectSlug} />
          <label>
            <span>周期</span>
            <select
              data-testid="report-schedule-frequency-input"
              defaultValue={settings.frequency}
              name="frequency"
              required
            >
              {FREQUENCY_OPTIONS.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {reportScheduleFrequencyLabel(frequency)}
                </option>
              ))}
            </select>
          </label>
          <PendingSubmitButton
            className="primary-button"
            testId="report-schedule-save-button"
            title="Save report schedule"
          >
            保存
          </PendingSubmitButton>
        </ActionForm>
      ) : (
        <MemberReadonly frequency={settings.frequency} />
      )}
      <dl className="detail-list stacked report-schedule-status-list">
        <DetailItem
          label="次回実行"
          testId="report-schedule-next-run"
          value={formatReportScheduleTimestamp(settings.nextRunAt)}
        />
        <DetailItem
          label="前回成功"
          testId="report-schedule-last-success"
          value={formatReportScheduleTimestamp(settings.lastSucceededAt)}
        />
        <DetailItem
          label="前回失敗"
          testId="report-schedule-last-failure"
          value={formatReportScheduleTimestamp(settings.lastFailedAt)}
        />
        <DetailItem
          label="リトライ回数"
          testId="report-schedule-retry-count"
          value={String(settings.retryCount)}
        />
        <DetailItem
          label="直近エラー"
          testId="report-schedule-last-error"
          value={settings.lastError ?? 'なし'}
        />
      </dl>
      <div className="report-schedule-run-summary" data-testid="report-schedule-run-summary">
        <h3>実行状態サマリー</h3>
        <ul className="report-schedule-summary-grid">
          <SummaryItem label="pending" value={settings.periodRunSummary.pending} />
          <SummaryItem label="running" value={settings.periodRunSummary.running} />
          <SummaryItem label="retry_wait" value={settings.periodRunSummary.retryWait} />
          <SummaryItem label="retry_exhausted" value={settings.periodRunSummary.retryExhausted} />
          <SummaryItem label="skipped" value={settings.periodRunSummary.skipped} />
          <SummaryItem label="succeeded" value={settings.periodRunSummary.succeeded} />
          <SummaryItem
            label="backfill remaining"
            testId="report-schedule-backfill-remaining"
            value={settings.periodRunSummary.backfillRemaining}
          />
        </ul>
      </div>
      {settings.recentPeriodRuns.length > 0 ? (
        <RecentRuns runs={settings.recentPeriodRuns} />
      ) : (
        <p className="notice" data-testid="report-schedule-recent-runs-empty">
          period run はまだありません。
        </p>
      )}
    </section>
  );
}

/**
 * Displays the report schedule frequency as read-only information.
 *
 * @param frequency - The configured report schedule frequency
 */
function MemberReadonly({ frequency }: { readonly frequency: ReportScheduleFrequency }) {
  return (
    <div className="report-schedule-readonly" data-testid="report-schedule-member-readonly">
      <dl className="detail-list stacked">
        <DetailItem
          label="周期"
          testId="report-schedule-readonly-frequency"
          value={reportScheduleFrequencyLabel(frequency)}
        />
      </dl>
    </div>
  );
}

/**
 * Displays recent report period runs with their date range, status, run kind, and any error message.
 *
 * @param runs - The recent period runs to display
 */
function RecentRuns({
  runs,
}: {
  readonly runs: ProjectReportScheduleSettingsView['recentPeriodRuns'];
}) {
  return (
    <div className="report-schedule-recent-runs" data-testid="report-schedule-recent-runs">
      <h3>直近の period run</h3>
      <ul className="source-list">
        {runs.map((run) => (
          <li
            className="source-chip"
            data-testid={`report-schedule-period-run-${run.id}`}
            key={run.id}
          >
            <strong>
              {run.periodStart} – {run.periodEnd}
            </strong>
            <span>
              {reportSchedulePeriodRunStatusLabel(run.status)} / {run.runKind}
            </span>
            {run.lastError ? <small>{run.lastError}</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Renders a labeled detail value for a definition list.
 *
 * @param label - The detail label
 * @param testId - The test identifier for the value element
 * @param value - The detail value
 */
function DetailItem({
  label,
  testId,
  value,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

function SummaryItem({
  label,
  testId,
  value,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly value: number;
}) {
  return (
    <li data-testid={testId}>
      <span>{label}</span>
      <strong>{value}</strong>
    </li>
  );
}
