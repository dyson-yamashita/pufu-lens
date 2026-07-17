'use server';

const E2E_REPORT_SCHEDULE_SAVE_DELAY_MS = 1_500;

/**
 * Delays report schedule form submission so Playwright can observe pending UI state.
 *
 * This action is only reachable from the fixture-fallback E2E harness route.
 */
export async function delayReportScheduleSaveForE2e(_formData: FormData): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, E2E_REPORT_SCHEDULE_SAVE_DELAY_MS);
  });
}
