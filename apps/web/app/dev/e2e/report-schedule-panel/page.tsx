import { notFound } from 'next/navigation';
import { ReportSchedulePanel } from '../../../../src/report-schedule-panel';
import { createDefaultReportScheduleSettingsView } from '../../../../src/report-schedule-settings.ts';
import { isFixtureFallbackEnabled } from '../../../../src/runtime-guards.ts';
import { delayReportScheduleSaveForE2e } from './actions.ts';

/**
 * Renders the report schedule panel for Playwright E2E pending-submit coverage.
 *
 * Returns 404 outside non-production fixture-fallback environments.
 */
export default function ReportSchedulePanelE2eHarnessPage() {
  if (!isFixtureFallbackEnabled() || process.env.PUFU_LENS_ENABLE_FIXTURE_FALLBACK !== 'true') {
    notFound();
  }

  return (
    <main data-testid="report-schedule-e2e-harness">
      <ReportSchedulePanel
        canManage
        projectSlug="sample-a"
        settings={createDefaultReportScheduleSettingsView()}
        updateAction={delayReportScheduleSaveForE2e}
      />
    </main>
  );
}
