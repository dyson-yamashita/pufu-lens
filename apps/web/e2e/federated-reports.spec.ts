import { expect, test } from '@playwright/test';

const unsafeSummary =
  '<p>Fixture <strong>summary</strong></p><script>alert(1)</script><img src="https://evil.example/x.png" /><a href="javascript:alert(1)">bad</a>';

const fixtureResponse = {
  status: 'ok',
  blockedCount: 0,
  reports: [
    {
      title: 'Fixture external report',
      sourceActor: 'https://remote.fixture.example/users/alice',
      domain: 'remote.fixture.example',
      publishedAt: '2026-08-01T12:00:00.000Z',
      summaryHtmlSanitized: unsafeSummary,
      originalUrl: 'https://remote.fixture.example/reports/1',
    },
  ],
};

async function mockPrivateReportsApi(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/sample-a/reports', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reports: [] }),
    });
  });
}

async function mockFederatedReportsApi(
  page: import('@playwright/test').Page,
  body: unknown,
  status = 200,
) {
  await page.route('**/api/projects/sample-a/federated-reports', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function openSampleReportsPage(page: import('@playwright/test').Page) {
  await mockPrivateReportsApi(page);
  await mockFederatedReportsApi(page, fixtureResponse);
  await page.goto('/projects/sample-a/reports');
}

async function assertExternalReportCard(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { name: '自分のレポート' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '外部レポート' })).toBeVisible();
  await expect(page.getByTestId('federated-report-card')).toBeVisible();
  await expect(page.getByTestId('federated-report-source-actor')).toHaveText(
    'https://remote.fixture.example/users/alice',
  );
  await expect(page.getByTestId('federated-report-domain')).toHaveText('remote.fixture.example');
  const link = page.getByTestId('federated-report-original-link');
  await expect(link).toHaveAttribute('href', 'https://remote.fixture.example/reports/1');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const summary = page.getByTestId('federated-report-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('summary');
  await expect(summary.locator('script')).toHaveCount(0);
  await expect(summary.locator('img')).toHaveCount(0);
  await expect(summary.locator('iframe')).toHaveCount(0);
  await expect(summary.locator('[onclick]')).toHaveCount(0);
  await expect(summary.locator('a[href^="javascript:"]')).toHaveCount(0);
  const box = await summary.boundingBox();
  const viewport = page.viewportSize();
  assertWithinViewport(box, viewport);
}

function assertWithinViewport(
  box: { x: number; width: number } | null,
  viewport: { width: number } | null,
) {
  expect(box).not.toBeNull();
  if (!box || !viewport) {
    return;
  }
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

test('scenario: federated reports page separates private and external panels on sample reports route', async ({
  page,
}) => {
  await openSampleReportsPage(page);
  await assertExternalReportCard(page);
});

test('scenario: federated reports page separates private and external panels @mobile', async ({
  page,
}) => {
  await openSampleReportsPage(page);
  await assertExternalReportCard(page);
});

test('scenario: federated reports loading and empty states', async ({ page }) => {
  await mockPrivateReportsApi(page);
  await page.route('**/api/projects/sample-a/federated-reports', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', blockedCount: 0, reports: [] }),
    });
  });
  await page.goto('/projects/sample-a/reports');
  await expect(page.getByTestId('federated-reports-loading')).toBeVisible();
  await expect(page.getByTestId('federated-reports-empty')).toBeVisible();
});

test('scenario: federated reports error and blocked states', async ({ page }) => {
  await mockPrivateReportsApi(page);
  await mockFederatedReportsApi(page, { error: { code: 'forbidden' } }, 403);
  await page.goto('/projects/sample-a/reports');
  await expect(page.getByTestId('federated-reports-error')).toBeVisible();

  await mockFederatedReportsApi(page, { status: 'blocked', blockedCount: 2, reports: [] });
  await page.reload();
  await expect(page.getByTestId('federated-reports-blocked')).toBeVisible();
});

test('scenario: federated reports mixed blocked notice', async ({ page }) => {
  await mockPrivateReportsApi(page);
  await mockFederatedReportsApi(page, { ...fixtureResponse, blockedCount: 1 });
  await page.goto('/projects/sample-a/reports');
  await expect(page.getByTestId('federated-reports-mixed-blocked')).toBeVisible();
});
