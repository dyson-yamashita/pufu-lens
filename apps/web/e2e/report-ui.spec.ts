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
      markdown: '- 仕様更新とレポート UI の情報が増えており、判断材料は蓄積されつつあります。',
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

test('scenario: member opens private report detail from list and sees sections', async ({
  page,
}) => {
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
  await expect(page.getByTestId('reports-generate-button')).toBeEnabled();
  await expect(page.getByTestId('reports-table')).toContainText(report.title);

  await expect(page.getByRole('link', { name: report.title })).toHaveAttribute(
    'href',
    '/projects/sample-a/reports/report-a',
  );
  await page.goto('/projects/sample-a/reports/report-a');
  await expect(page.getByTestId('report-document')).toContainText(report.summary);
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
  await expect(page.getByTestId('report-section-progress')).toContainText('判断材料');
  await expect(page.getByTestId('report-source-doc-a')).toContainText('web');
  await expect(page.getByRole('link', { name: 'Spec Update' })).toHaveAttribute(
    'href',
    'https://example.com/spec',
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
  await expect
    .poll(async () =>
      page
        .getByTestId('pufu-report-score')
        .locator('[role="score"][aria-label="box"]')
        .evaluate((element) => element.classList.contains('dark')),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page
        .locator('.pufu-score-frame')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await page.getByTestId('theme-toggle-button').click();
  await expect
    .poll(async () =>
      page
        .getByTestId('pufu-report-score')
        .locator('[role="score"][aria-label="box"]')
        .evaluate((element) => element.classList.contains('dark')),
    )
    .toBe(false);
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
  await expect(page.getByTestId('report-section-risks')).toBeVisible();
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
  await expect
    .poll(async () =>
      page
        .getByTestId('pufu-report-score')
        .locator('[role="score"][aria-label="box"]')
        .evaluate((element) => Math.round(element.getBoundingClientRect().width)),
    )
    .toBeGreaterThanOrEqual(720);
  await expect
    .poll(async () =>
      page
        .locator('.pufu-score-frame')
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    )
    .toBe(true);
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
      body: JSON.stringify({ report, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.goto('/reports/public/sample-a/report-a');

  await expect(page.getByTestId('global-nav')).toBeVisible();
  await expect(page.getByTestId('global-nav-reports')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Public Report' })).toBeVisible();
  await expect(page.getByTestId('public-report-document')).toContainText(report.summary);
  await expect(page.getByTestId('pufu-report-viewer')).toBeVisible();
  await expect(page.getByTestId('pufu-report-score')).toBeVisible();
  await expect(page.getByTestId('public-report-section-progress')).toContainText('判断材料');
  await expect(page.getByTestId('public-report-source-doc-a')).toContainText('web');
  await expect(page.getByTestId('public-report-source-doc-a').getByRole('link')).toHaveAttribute(
    'href',
    'https://example.com/spec',
  );
  await expect(page.getByTestId('public-report-document')).toContainText('Spec Update');

  await expect(page.getByTestId('public-chat-panel')).toHaveCount(0);
  await expect(page.getByTestId('public-chat-question-input')).toHaveCount(0);
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
