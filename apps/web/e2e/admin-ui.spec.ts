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
  await expect(page.getByTestId('theme-toggle-button')).toHaveAttribute(
    'aria-label',
    /ライトテーマに切り替える/,
  );

  await page.getByTestId('theme-toggle-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle-button')).toHaveAttribute(
    'aria-label',
    /ダークテーマに切り替える/,
  );

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle-button')).toHaveAttribute(
    'aria-label',
    /ダークテーマに切り替える/,
  );

  await page.getByTestId('theme-toggle-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('scenario: public user discovers public projects without private admin links', async ({
  page,
}) => {
  await page.goto('/projects');

  await expect(page.getByTestId('global-nav')).toBeVisible();
  await expect(page.getByTestId('global-nav-data-sources')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-parser-profiles')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-settings')).toHaveCount(0);
  await expect(page.getByTestId('project-list')).toHaveCount(0);
  await expect(page.getByTestId('project-card-sample-a')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Public Projects' })).toBeVisible();
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
  const protectedAdminPaths = [
    '/projects/sample-a/admin/data-sources',
    '/projects/sample-a/admin/settings',
  ];

  for (const path of protectedAdminPaths) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-panel')).toBeVisible();
    await expect(page.getByTestId('data-source-table')).toHaveCount(0);
    await expect(page.getByTestId('project-settings-form')).toHaveCount(0);
  }

  const removedParserProfilesResponse = await page.goto('/projects/sample-a/admin/parser-profiles');
  expect(removedParserProfilesResponse?.status()).toBe(404);
  await expect(page.getByTestId('parser-profile-list')).toHaveCount(0);
  await expect(page.getByTestId('parser-profile-create-button')).toHaveCount(0);
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

  test('scenario: admin user hides Public Projects when member projects cover visible public projects', async ({
    page,
  }) => {
    await page.goto('/projects');

    await expect(page.getByTestId('project-list')).toBeVisible();
    await expect(page.getByTestId('project-card-sample-a')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Public Projects' })).toHaveCount(0);
    await expect(page.getByTestId('public-project-list')).toHaveCount(0);
    await expect(page.getByTestId('public-project-sample-a')).toHaveCount(0);
  });

  test('scenario: admin user can inspect stable operation controls', async ({ page }) => {
    await page.goto('/projects/sample-a/admin/data-sources');
    await expect(page.getByTestId('data-source-table')).toBeVisible();
    await expect(page.getByTestId('data-source-create-panel')).toBeVisible();
    await expect(page.getByTestId('data-source-submit-button')).toHaveText('Create & Collect');
    await expect(page.getByTestId('data-source-add-button')).toHaveCount(0);
    await expect(page.getByTestId('data-source-detail-panel')).toHaveCount(0);
    await expect(page.getByTestId('source-type-web-tab')).toBeVisible();
    await expect(page.getByTestId('global-nav-overview')).toBeVisible();
    await expect(page.getByTestId('global-nav-overview')).toHaveAttribute(
      'href',
      '/projects/sample-a',
    );
    await expect(page.getByTestId('global-nav-settings')).toBeVisible();
    await expect(page.getByTestId('global-nav-parser-profiles')).toHaveCount(0);

    await page.goto('/projects/sample-a/admin/data-sources?sourceType=web');
    await expect(page).toHaveURL(/\/projects\/sample-a\/admin\/data-sources\?sourceType=web$/);
    await expect(page.getByTestId('source-type-web-tab')).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByTestId('data-source-table').getByText(/Fixture web|公開ドキュメント/),
    ).toBeVisible();
    await expect(page.getByTestId('data-source-collect-ingest-sample-a-web-docs')).toBeVisible();
    await expect(page.getByTestId('data-source-history-sample-a-web-docs')).toBeVisible();
    await expect(page.getByTestId('data-source-retry-sample-a-web-docs')).toBeDisabled();
    await expect(page.getByTestId('data-source-table').getByText('Fixture drive')).toHaveCount(0);
    await expect(
      page.getByTestId('data-source-table').getByText('Drive プロダクト資料'),
    ).toHaveCount(0);

    await page.goto(
      '/projects/sample-a/admin/data-sources?dataSourceId=sample-a-web-docs&sourceType=web',
    );
    await expect(page.getByTestId('data-source-detail-panel')).toBeVisible();
    await expect(page.getByTestId('data-source-content-panel')).toBeVisible();
    await expect(page.getByTestId('data-source-content-document-row').first()).toBeVisible();
    await expect(page.getByTestId('data-source-content-snippet').first()).toBeVisible();
    await expect(page.getByTestId('data-source-queue-preview')).toBeVisible();
    await expect(page.getByTestId('data-source-settings-section')).toBeVisible();
    await expect(page.getByTestId('data-source-schedule-unavailable')).toBeVisible();
    await expect(page.getByTestId('data-source-edit-name-input')).toBeVisible();
    await expect(page.getByTestId('data-source-save-button')).toBeEnabled();
    await page.getByTestId('data-source-detail-dialog-close-button').click();
    await expect(page.getByTestId('data-source-detail-panel')).toHaveCount(0);
    await expect(page).toHaveURL(/\/projects\/sample-a\/admin\/data-sources\?sourceType=web$/);

    await page.goto('/projects/sample-a/admin/data-sources?dataSourceId=sample-a-github-main');
    await expect(page.getByTestId('data-source-selected-connection-notice')).toBeVisible();
    await expect(page.getByTestId('data-source-schedule-form')).toBeVisible();
    await expect(page.getByTestId('data-source-schedule-time')).toHaveValue('10:00');
    await expect(page.getByTestId('data-source-save-button')).toBeEnabled();
    await expect(page.getByTestId('data-source-test-button')).toHaveCount(0);
    await expect(page.getByTestId('data-source-run-button')).toBeDisabled();
    await expect(
      page.getByTestId('data-source-collect-ingest-sample-a-github-main'),
    ).toBeDisabled();

    await page.goto('/projects/sample-a/admin/settings');
    await expect(page.getByTestId('project-settings-form')).toBeVisible();
    await expect(page.getByTestId('connection-google-operation-notice')).toBeVisible();
    await expect(page.getByTestId('connection-github-operation-notice')).toBeVisible();
  });

  test('scenario: admin user cannot open removed parser profiles route', async ({ page }) => {
    const response = await page.goto('/projects/sample-a/admin/parser-profiles');
    expect(response?.status()).toBe(404);
    await expect(page.getByTestId('parser-profile-list')).toHaveCount(0);
    await expect(page.getByTestId('parser-profile-create-button')).toHaveCount(0);
  });
});
