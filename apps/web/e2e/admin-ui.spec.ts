import { expect, test } from '@playwright/test';

const adminCredentials = {
  email: process.env.PUFU_LENS_E2E_ADMIN_EMAIL,
  password: process.env.PUFU_LENS_E2E_ADMIN_PASSWORD,
};

test('scenario: user can switch theme and keep it after reload', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/projects');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-toggle')).toBeVisible();

  await page.getByTestId('theme-toggle-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByTestId('theme-toggle-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('scenario: public user discovers public projects without private admin links', async ({
  page,
}) => {
  await page.goto('/projects');

  await expect(page.getByTestId('global-nav')).toBeVisible();
  await expect(page.getByTestId('global-nav-data-sources')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-ingestion')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-parser-profiles')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-settings')).toHaveCount(0);
  await expect(page.getByTestId('project-list')).toHaveCount(0);
  await expect(page.getByTestId('project-card-sample-a')).toHaveCount(0);
  await expect(page.getByTestId('public-project-list')).toBeVisible();
  await expect(page.getByTestId('public-project-sample-a')).toBeVisible();
  await expect(page.getByTestId('public-report-sample-a-report-a')).toHaveCount(0);
  await expect(page.getByTestId('public-project-open-sample-a')).toHaveAttribute(
    'href',
    '/projects/sample-a',
  );

  await page.getByTestId('public-project-open-sample-a').click();
  await expect(page.getByTestId('global-nav-overview')).toBeVisible();
  await expect(page.getByTestId('global-nav-overview')).toHaveAttribute(
    'href',
    '/projects/sample-a',
  );
  await expect(page.getByTestId('global-nav-overview')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('global-nav-settings')).toHaveCount(0);

  const nav = page.getByTestId('guest-side-menu');
  const projectsIndex = await nav.getByTestId('global-nav-projects').evaluate((node) => {
    return Array.from(node.parentElement?.children ?? []).indexOf(node);
  });
  const overviewIndex = await nav.getByTestId('global-nav-overview').evaluate((node) => {
    return Array.from(node.parentElement?.children ?? []).indexOf(node);
  });
  const chatIndex = await nav.getByTestId('global-nav-chat').evaluate((node) => {
    return Array.from(node.parentElement?.children ?? []).indexOf(node);
  });
  expect(projectsIndex).toBeGreaterThanOrEqual(0);
  expect(overviewIndex).toBe(projectsIndex + 1);
  expect(chatIndex).toBe(overviewIndex + 1);
});

test('scenario: public user cannot open admin operation pages directly', async ({ page }) => {
  const adminPaths = [
    '/projects/sample-a/admin/data-sources',
    '/projects/sample-a/admin/ingestion',
    '/projects/sample-a/admin/parser-profiles',
    '/projects/sample-a/admin/settings',
  ];

  for (const path of adminPaths) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-panel')).toBeVisible();
    await expect(page.getByTestId('data-source-table')).toHaveCount(0);
    await expect(page.getByTestId('ingestion-status-list')).toHaveCount(0);
    await expect(page.getByTestId('parser-profile-list')).toHaveCount(0);
    await expect(page.getByTestId('project-settings-form')).toHaveCount(0);
  }
});

test.describe('authenticated admin operation controls', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !adminCredentials.email || !adminCredentials.password,
      'PUFU_LENS_E2E_ADMIN_EMAIL and PUFU_LENS_E2E_ADMIN_PASSWORD are required.',
    );

    await page.goto('/login');
    await page.getByTestId('credentials-email-input').fill(adminCredentials.email ?? '');
    await page.getByTestId('credentials-password-input').fill(adminCredentials.password ?? '');
    await page.getByTestId('credentials-login-button').click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('scenario: admin user can inspect stable operation controls', async ({ page }) => {
    await page.goto('/projects/sample-a/admin/data-sources');
    await expect(page.getByTestId('data-source-table')).toBeVisible();
    await expect(page.getByTestId('data-source-detail-panel')).toBeVisible();
    await expect(page.getByTestId('source-type-web-tab')).toBeVisible();
    await expect(page.getByTestId('global-nav-overview')).toBeVisible();
    await expect(page.getByTestId('global-nav-overview')).toHaveAttribute(
      'href',
      '/projects/sample-a',
    );
    await expect(page.getByTestId('global-nav-settings')).toBeVisible();

    await page.goto('/projects/sample-a/admin/data-sources?sourceType=web');
    await expect(page).toHaveURL(/\/projects\/sample-a\/admin\/data-sources\?sourceType=web$/);
    await expect(page.getByTestId('source-type-web-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByTestId('data-source-table').getByText(/Fixture web|公開ドキュメント/),
    ).toBeVisible();
    await expect(page.getByTestId('data-source-edit-name-input')).toBeVisible();
    await expect(page.getByTestId('data-source-edit-scope-input')).toBeVisible();
    await expect(page.getByTestId('data-source-save-button')).toBeEnabled();
    await expect(page.getByTestId('data-source-table').getByText('Fixture drive')).toHaveCount(0);
    await expect(
      page.getByTestId('data-source-table').getByText('Drive プロダクト資料'),
    ).toHaveCount(0);

    await page.goto(
      '/projects/sample-a/admin/data-sources?dataSourceId=sample-a-web-docs&sourceType=web',
    );
    await expect(page.getByTestId('data-source-content-panel')).toBeVisible();
    await expect(page.getByTestId('data-source-content-document-row').first()).toBeVisible();
    await expect(page.getByTestId('data-source-content-snippet').first()).toBeVisible();
    await expect(page.getByTestId('data-source-queue-preview')).toBeVisible();
    await expect(page.getByTestId('data-source-settings-section')).toBeVisible();
    await expect(page.getByTestId('data-source-edit-name-input')).toBeVisible();
    await expect(page.getByTestId('data-source-save-button')).toBeEnabled();

    await page.goto('/projects/sample-a/admin/ingestion');
    await expect(page.getByTestId('ingestion-status-list')).toBeVisible();
    await expect(page.getByTestId('ingestion-retry-failed-button')).toBeVisible();

    await page.goto('/projects/sample-a/admin/parser-profiles');
    await expect(page.getByTestId('parser-profile-list')).toBeVisible();
    await expect(page.getByTestId('parser-profile-create-button')).toBeVisible();

    await page.goto('/projects/sample-a/admin/settings');
    await expect(page.getByTestId('project-settings-form')).toBeVisible();
  });
});
