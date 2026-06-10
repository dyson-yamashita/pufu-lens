import { expect, test } from '@playwright/test';

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
  await expect(page.getByTestId('global-nav-settings')).toHaveCount(0);

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
  await expect(page.getByTestId('data-source-table').getByText('Drive プロダクト資料')).toHaveCount(
    0,
  );

  await page.goto('/projects/sample-a/admin/ingestion');
  await expect(page.getByTestId('ingestion-status-list')).toBeVisible();
  await expect(page.getByTestId('ingestion-retry-failed-button')).toBeVisible();

  await page.goto('/projects/sample-a/admin/parser-profiles');
  await expect(page.getByTestId('parser-profile-list')).toBeVisible();
  await expect(page.getByTestId('parser-profile-create-button')).toBeVisible();

  await page.goto('/projects/sample-a/admin/settings');
  await expect(page.getByTestId('project-settings-form')).toBeVisible();
  await expect(page.getByTestId('project-settings-name-input')).toBeVisible();
  await expect(page.getByTestId('project-settings-description-input')).toBeVisible();
  await expect(page.getByTestId('project-settings-visibility-select')).toBeVisible();
  await expect(page.getByTestId('project-settings-save-button')).toBeEnabled();
  await expect(page.getByTestId('project-settings-visibility-sample-a')).toHaveText('public');
});
