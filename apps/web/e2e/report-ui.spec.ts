import { expect, test } from '@playwright/test';

const report = {
  generated_at: '2026-06-04T09:00:00.000Z',
  period: { end: '2026-06-07', start: '2026-06-01' },
  project_id: 'project-a',
  report_id: 'report-a',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown: '- Spec Update\n- Report UI',
      sources: [
        {
          canonical_uri: 'https://example.com/spec',
          doc_type: 'web_page',
          document_id: 'doc-a',
          snippet: 'Spec Update',
        },
      ],
      title: 'アクティビティ',
    },
    {
      id: 'issues',
      items: [{ document_id: 'doc-issue', title: 'Issue #42' }],
      markdown: '- Issue #42',
      title: '未解決 Issue',
    },
    {
      id: 'progress',
      markdown: '2 件の document を確認しました。',
      metrics: { documents: 2, merged_prs: 1, open_issues: 1 },
      title: '進捗',
    },
    {
      id: 'risks',
      items: [],
      markdown: '- 重大なリスク候補は見つかりませんでした。',
      title: 'リスク',
    },
  ],
  summary: '2 件の indexed document から週次レポートを生成しました。',
  title: '週次レポート 2026-06-01 - 2026-06-07',
};

test('private report list links to detail and renders sections', async ({ page }) => {
  await page.route('**/api/projects/sample-a/reports', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        reports: [
          {
            createdAt: '2026-06-04T09:00:00.000Z',
            id: 'report-a',
            isPublic: false,
            period: report.period,
            schemaVersion: 'v1',
            storageUri: 'file:///tmp/sample-a/reports/private/report-a.json',
            summary: report.summary,
            title: report.title,
          },
        ],
        status: 'ok',
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/projects/sample-a/reports/report-a', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ report, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/reports');
  await expect(page.getByTestId('global-nav-reports')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('reports-table')).toContainText(report.title);

  await page.getByRole('link', { name: report.title }).click();
  await expect(page.getByTestId('report-document')).toContainText(report.summary);
  await expect(page.getByTestId('report-section-activity')).toContainText('Spec Update');
  await expect(page.getByTestId('report-section-progress')).toContainText('documents');
});

test('private report detail keeps sections visible on mobile', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await page.route('**/api/projects/sample-a/reports/report-a', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ report, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/reports/report-a');

  await expect(page.getByTestId('report-document')).toBeVisible();
  await expect(page.getByTestId('report-section-activity')).toBeVisible();
  await expect(page.getByTestId('report-section-issues')).toBeVisible();
  await expect(page.getByTestId('report-section-progress')).toBeVisible();
  await expect(page.getByTestId('report-section-risks')).toBeVisible();
});
