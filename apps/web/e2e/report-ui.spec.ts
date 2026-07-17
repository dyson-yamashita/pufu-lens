import { expect, test } from '@playwright/test';

const report = {
  generated_at: '2026-06-04T09:00:00.000Z',
  period: { end: '2026-06-07', start: '2026-06-01' },
  pufu_sources: [
    {
      canonical_uri: 'https://note.example.com/osc-osaka',
      doc_type: 'web_page',
      document_id: 'doc-osc',
      occurred_at: '2026-01-31T15:24:00.000Z',
      snippet:
        '昨年に引き続き、オープンソースカンファレンス＠大阪に「プ譜友の会」からプ譜エディターを出展しました。',
      title: '【プ譜友の会】オープンソースカンファレンス2026＠大阪の出展レポート',
    },
  ],
  project_id: 'project-a',
  report_id: 'report-a',
  schema_version: 'v1',
  sections: [
    {
      id: 'activity',
      markdown:
        '対象期間に確認できた情報から、プロジェクトは仕様整理とレポート体験の改善を進めている状態です。',
      title: '概況',
    },
    {
      id: 'progress',
      markdown:
        '- **仕様更新**とレポート UI の情報が増えています。\n- [判断材料](https://example.com/progress)は蓄積されつつあります。',
      sources: [
        {
          canonical_uri: 'https://example.com/spec',
          doc_type: 'web_page',
          document_id: 'doc-a',
          snippet: 'Spec Update',
          title: 'Spec Update',
        },
      ],
      title: '進行状況',
    },
    {
      id: 'risks',
      items: [],
      markdown: '失敗時の導線が不明瞭なままだと、利用者の理解を阻む可能性があります。',
      title: '課題・次のアクション',
    },
  ],
  summary: '2 件の indexed document から、プロジェクトの概況と進行状況を整理しました。',
  title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
};

const scheduledReport = {
  ...report,
  recurrence: {
    change_summary: '前回から仕様整理が進み、未解決の運用課題が継続しています。',
    continued_items: ['公開範囲の確認を継続する'],
    decrements: ['未整理の仕様項目が 2 件減少した'],
    frequency: 'weekly',
    increments: ['レポート UI の判断材料が追加された'],
    previous_report_id: 'report-previous',
  },
  report_id: 'report-scheduled',
};

test('scenario: member sees pending save label while report schedule form submits', async ({
  page,
}) => {
  await page.goto('/dev/e2e/report-schedule-panel');

  await expect(page.getByTestId('report-schedule-panel')).toBeVisible();
  await expect(page.getByTestId('report-schedule-timezone-note')).toContainText(
    '1件の履歴レポート',
  );

  const saveButton = page.getByTestId('report-schedule-save-button');
  await expect(saveButton).toHaveText('保存');
  await page.getByTestId('report-schedule-frequency-input').selectOption('weekly');
  await saveButton.click();

  await expect(saveButton).toHaveText('保存中...');
  await expect(saveButton).toBeDisabled();
  await expect(saveButton).toHaveAttribute('aria-busy', 'true');
  await expect(saveButton).toHaveText('保存', { timeout: 10_000 });
});

test('scenario: member opens private report detail from list and sees sections', async ({
  page,
}) => {
  await page.route('**/api/projects/sample-a/reports', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        reports: [
          {
            createdAt: '2026-06-04T09:00:00.000Z',
            generationKind: 'manual',
            id: 'report-a',
            isPublic: false,
            period: report.period,
            schemaVersion: 'v1',
            scheduleFrequency: null,
            schedulePeriodRunId: null,
            storageUri: 'file:///tmp/sample-a/reports/private/report-a.json',
            summary: report.summary,
            title: report.title,
          },
          {
            createdAt: '2026-06-11T09:00:00.000Z',
            generationKind: 'scheduled',
            id: 'report-scheduled',
            isPublic: false,
            period: scheduledReport.period,
            previousScheduledReportId: 'report-a',
            schemaVersion: 'v1',
            scheduleFrequency: 'weekly',
            schedulePeriodRunId: 'run-scheduled',
            storageUri: 'file:///tmp/sample-a/reports/private/report-scheduled.json',
            summary: scheduledReport.summary,
            title: scheduledReport.title,
          },
          {
            createdAt: '2026-06-12T09:00:00.000Z',
            generationKind: 'scheduled_backfill',
            id: 'report-backfill',
            isPublic: false,
            period: scheduledReport.period,
            previousScheduledReportId: null,
            schemaVersion: 'v1',
            scheduleFrequency: 'monthly',
            schedulePeriodRunId: 'run-backfill',
            storageUri: 'file:///tmp/sample-a/reports/private/report-backfill.json',
            summary: scheduledReport.summary,
            title: `${scheduledReport.title} backfill`,
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
  await expect(page.getByTestId('reports-generate-button')).toBeEnabled();
  await expect(page.getByTestId('reports-table')).toContainText(report.title);
  await expect(page.getByTestId('report-generation-report-a')).toHaveText('手動');
  await expect(page.getByTestId('report-generation-report-scheduled')).toHaveText('定期（週次）');
  await expect(page.getByTestId('report-generation-report-backfill')).toHaveText(
    '定期 backfill（月次）',
  );

  await expect(
    page.getByTestId('report-row-report-a').getByRole('link', { name: report.title, exact: true }),
  ).toHaveAttribute('href', '/projects/sample-a/reports/report-a');
  await page.goto('/projects/sample-a/reports/report-a');
  await expect(page.getByTestId('report-document')).toContainText(report.summary);
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
  await expect(page.getByTestId('report-section-progress')).toContainText('判断材料');
  await expect(page.getByTestId('report-section-progress').locator('ul')).toHaveCount(1);
  await expect(page.getByTestId('report-section-progress').locator('ul > li')).toHaveCount(2);
  await expect(
    page.getByTestId('report-section-progress').locator('.report-markdown strong'),
  ).toHaveText('仕様更新');
  await expect(
    page.getByTestId('report-section-progress').getByRole('link', { name: '判断材料' }),
  ).toHaveAttribute('href', 'https://example.com/progress');
  await expect(page.getByTestId('report-source-doc-a')).toContainText('web');
  await expect(page.getByRole('link', { name: 'Spec Update' })).toHaveAttribute(
    'href',
    'https://example.com/spec',
  );
  await expect(page.getByTestId('report-recurrence')).toHaveCount(0);
});

test('scenario: member scrolls private reports table on mobile with summary preview @mobile', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 390 });
  const expectedSummaryPreview = `${'あ'.repeat(100)}...`;
  const longSummary = `${'あ'.repeat(101)}続きの説明文`;

  await page.route('**/api/projects/sample-a/reports', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        reports: [
          {
            createdAt: '2026-06-04T09:00:00.000Z',
            generationKind: 'manual',
            id: 'report-a',
            isPublic: false,
            period: report.period,
            schemaVersion: 'v1',
            scheduleFrequency: null,
            schedulePeriodRunId: null,
            storageUri: 'file:///tmp/sample-a/reports/private/report-a.json',
            summary: longSummary,
            title: report.title,
          },
        ],
        status: 'ok',
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/reports');

  const tableFrame = page.locator('.table-frame');
  await expect(tableFrame).toHaveCSS('overflow-x', 'auto');
  await expect(page.getByTestId('reports-table')).toContainText(expectedSummaryPreview);
  await expect(page.getByTestId('reports-table')).not.toContainText(longSummary);
  await expect(page.getByTestId('reports-generate-button')).toBeInViewport();
  await expect(tableFrame).toBeInViewport();
});

test('scenario: member reads scheduled report recurrence on mobile @mobile', async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 390 });
  await page.route('**/api/projects/sample-a/reports/report-scheduled', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ report: scheduledReport, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/reports/report-scheduled');

  const recurrence = page.getByTestId('report-recurrence');
  await expect(recurrence).toBeVisible();
  await expect(page.getByTestId('report-recurrence-frequency')).toHaveText('週次');
  await expect(page.getByTestId('report-recurrence-summary')).toHaveText(
    scheduledReport.recurrence.change_summary,
  );
  await expect(page.getByTestId('report-recurrence-increments')).toContainText(
    scheduledReport.recurrence.increments[0],
  );
  await expect(page.getByTestId('report-recurrence-decrements')).toContainText(
    scheduledReport.recurrence.decrements[0],
  );
  await expect(page.getByTestId('report-recurrence-continued_items')).toContainText(
    scheduledReport.recurrence.continued_items[0],
  );
  await expect(recurrence).toBeInViewport();
  await expect(recurrence.locator('.report-recurrence-groups')).toHaveCSS(
    'grid-template-columns',
    /^\d+(?:\.\d+)?px$/,
  );
});

test('scenario: private report pufu score stays inside viewport when side menu is open', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.route('**/api/projects/sample-a/reports/report-a', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ report, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/reports/report-a');

  await expect(page.getByTestId('global-nav')).toBeVisible();
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
  await expect(page.getByTestId('pufu-report-viewer')).toBeInViewport();
  await page.getByTestId('theme-toggle-button').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
});

test('scenario: member reads private report sections on mobile @mobile', async ({ page }) => {
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
  await expect(page.getByTestId('report-section-progress')).toBeVisible();
  await expect(page.getByTestId('report-section-progress').locator('ul')).toHaveCount(1);
  await expect(page.getByTestId('report-section-progress').locator('ul > li')).toHaveCount(2);
  await expect(
    page.getByTestId('report-section-progress').locator('.report-markdown strong'),
  ).toHaveText('仕様更新');
  await expect(
    page.getByTestId('report-section-progress').getByRole('link', { name: '判断材料' }),
  ).toHaveAttribute('href', 'https://example.com/progress');
  await expect(page.getByTestId('report-section-risks')).toBeVisible();
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
  await expect(page.getByTestId('pufu-report-viewer')).toBeVisible();
  await expect(page.locator('.pufu-score-frame')).toHaveCSS('overflow-x', 'auto');
});

test('scenario: member sees private report API error codes', async ({ page }) => {
  await page.route('**/api/projects/sample-a/reports', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'report_user_not_configured',
          message: 'PUFU_LENS_REPORT_USER_ID is required',
        },
      }),
      contentType: 'application/json',
      status: 503,
    });
  });
  await page.route('**/api/projects/sample-a/reports/missing-report', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: {
          code: 'report_not_found',
          message: 'Report not found: missing-report',
        },
      }),
      contentType: 'application/json',
      status: 404,
    });
  });

  await page.goto('/projects/sample-a/reports');
  await expect(page.getByTestId('reports-status')).toHaveText('report_user_not_configured');

  await page.goto('/projects/sample-a/reports/missing-report');
  await expect(page.getByTestId('report-status')).toHaveText('report_not_found');
});

test('scenario: public user reads report with shared private rendering and no question panel', async ({
  page,
}) => {
  await page.route('**/api/public/projects/sample-a/reports/report-a*', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ report: scheduledReport, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/reports/public/sample-a/report-a');

  await expect(page.getByTestId('global-nav')).toBeVisible();
  await expect(page.getByTestId('global-nav-reports')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Public Report' })).toBeVisible();
  await expect(page.getByTestId('public-report-document')).toContainText(report.summary);
  await expect(page.getByTestId('public-report-recurrence')).toBeVisible();
  await expect(page.getByTestId('public-report-recurrence-frequency')).toHaveText('週次');
  await expect(page.getByTestId('public-report-recurrence-summary')).toHaveText(
    scheduledReport.recurrence.change_summary,
  );
  await expect(page.getByTestId('pufu-report-viewer')).toBeVisible();
  await expect(page.getByTestId('pufu-report-score')).toBeVisible();
  await expect(page.getByTestId('public-report-section-progress')).toContainText('判断材料');
  await expect(page.getByTestId('public-report-section-progress').locator('ul')).toHaveCount(1);
  await expect(page.getByTestId('public-report-section-progress').locator('ul > li')).toHaveCount(
    2,
  );
  await expect(
    page.getByTestId('public-report-section-progress').locator('.report-markdown strong'),
  ).toHaveText('仕様更新');
  await expect(page.getByTestId('public-report-source-doc-a')).toContainText('web');
  await expect(page.getByTestId('public-report-source-doc-a').getByRole('link')).toHaveAttribute(
    'href',
    'https://example.com/spec',
  );
  await expect(page.getByTestId('public-report-document')).toContainText('Spec Update');

  await expect(page.getByTestId('public-chat-panel')).toHaveCount(0);
  await expect(page.getByTestId('public-chat-question-input')).toHaveCount(0);
  await expect(page.getByTestId('graph-viewer-panel')).toHaveCount(0);
  await expect(page.getByTestId('global-nav-graph')).toBeVisible();
  await expect(page.getByTestId('global-nav-graph')).toHaveAttribute(
    'href',
    '/projects/sample-a/graph',
  );
});

test('scenario: public report gate hides private project reports', async ({ page }) => {
  await page.route('**/api/public/projects/private-a/reports/report-a*', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: { code: 'public_report_not_found', message: 'Public report not found' },
      }),
      contentType: 'application/json',
      status: 404,
    });
  });

  await page.goto('/reports/public/private-a/report-a');

  await expect(page.getByTestId('public-report-status')).toHaveText('public_report_not_found');
  await expect(page.getByTestId('public-report-document')).toHaveCount(0);
});

test('scenario: hostile client sends unsafe input and public/publish APIs reject it @api', async ({
  request,
}) => {
  const unsafePublicResponse = await request.get(
    '/api/public/projects/%2E%2E%2Fsample-a/reports/report-a',
  );
  expect(unsafePublicResponse.status()).toBe(404);

  const unsafePublicChatResponse = await request.post(
    '/api/public/projects/sample-a/reports/%2E%2E%2Freport-a/chat',
    { data: { projectId: 'project-a', question: 'この公開レポートは?' } },
  );
  expect(unsafePublicChatResponse.status()).toBe(404);

  const longQuestionResponse = await request.post(
    '/api/public/projects/sample-a/reports/report-a/chat',
    { data: { question: 'あ'.repeat(2001) } },
  );
  expect(longQuestionResponse.status()).toBe(413);
  const longQuestionBody = await longQuestionResponse.json();
  expect(longQuestionBody.error.code).toBe('public_chat_question_too_long');

  const nullPublicChatResponse = await request.post(
    '/api/public/projects/sample-a/reports/report-a/chat',
    {
      data: 'null',
      headers: { 'content-type': 'application/json' },
    },
  );
  expect(nullPublicChatResponse.status()).toBe(400);
  const nullPublicChatBody = await nullPublicChatResponse.json();
  expect(nullPublicChatBody.error.code).toBe('invalid_request');

  const invalidPatchResponse = await request.patch('/api/projects/sample-a/reports/report-a', {
    data: '{not-json',
    headers: { 'content-type': 'application/json' },
  });
  expect(invalidPatchResponse.status()).toBe(400);
  const invalidPatchBody = await invalidPatchResponse.json();
  expect(invalidPatchBody.error.code).toBe('report_invalid_request');

  const nullPatchResponse = await request.patch('/api/projects/sample-a/reports/report-a', {
    data: 'null',
    headers: { 'content-type': 'application/json' },
  });
  expect(nullPatchResponse.status()).toBe(400);
  const nullPatchBody = await nullPatchResponse.json();
  expect(nullPatchBody.error.code).toBe('report_invalid_request');
});
