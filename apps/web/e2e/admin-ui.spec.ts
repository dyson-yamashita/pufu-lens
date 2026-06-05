import { expect, test } from '@playwright/test';

test('projects page links to project administration', async ({ page }) => {
  await page.goto('/projects');

  await expect(page.getByTestId('global-nav')).toBeVisible();
  await expect(page.getByTestId('global-nav-data-sources')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-ingestion')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-parser-profiles')).toHaveCount(0);
  await expect(page.getByTestId('project-list')).toBeVisible();
  await expect(page.getByTestId('project-card-sample-a')).toBeVisible();

  await page.getByTestId('project-open-sample-a').click();
  await expect(page).toHaveURL(/\/projects\/sample-a\/admin\/data-sources$/);
  await expect(page.getByTestId('data-source-table')).toBeVisible();
});

test('admin routes expose stable operation controls', async ({ page }) => {
  await page.goto('/projects/sample-a/admin/data-sources');
  await expect(page.getByTestId('data-source-table')).toBeVisible();
  await expect(page.getByTestId('data-source-detail-panel')).toBeVisible();
  await expect(page.getByTestId('source-type-web-tab')).toBeVisible();

  await page.getByTestId('source-type-web-tab').click();
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
});
