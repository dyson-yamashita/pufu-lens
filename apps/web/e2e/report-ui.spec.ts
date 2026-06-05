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
      sources: [
        {
          canonical_uri: 'https://example.com/spec',
          doc_type: 'web_page',
          document_id: 'doc-a',
          snippet: 'Spec Update',
        },
      ],
      title: '概況',
    },
    {
      id: 'issues',
      items: [{ document_id: 'doc-issue', title: 'Issue #42' }],
      markdown: 'ログイン失敗時の体験と、利用者が状況を理解できる説明が論点です。',
      title: '論点',
    },
    {
      id: 'progress',
      markdown: '仕様更新とレポート UI の情報が増えており、判断材料は蓄積されつつあります。',
      metrics: { discussion_points: 1, documents: 2, risk_signals: 1 },
      title: '進行状況',
    },
    {
      id: 'risks',
      items: [],
      markdown: '失敗時の導線が不明瞭なままだと、利用者の理解を阻む可能性があります。',
      title: '不確実性・リスク',
    },
  ],
  summary: '2 件の indexed document から、プロジェクトの概況と進行状況を整理しました。',
  title: 'プロジェクト状況レポート 2026-06-01 - 2026-06-07',
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
  await expect(page.getByTestId('reports-generate-button')).toBeDisabled();
  await expect(page.getByTestId('reports-table')).toContainText(report.title);

  await page.getByRole('link', { name: report.title }).click();
  await expect(page.getByTestId('report-document')).toContainText(report.summary);
  await expect(page.getByTestId('pufu-report-score')).toContainText('プ譜エディターを試す人');
  await expect(page.getByTestId('report-section-activity')).toContainText('Spec Update');
  await expect(page.getByTestId('report-section-progress')).toContainText('判断材料');
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

test('private report pages render API error codes', async ({ page }) => {
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

test('public report page renders redacted artifact only', async ({ page }) => {
  const publicReport = {
    period: report.period,
    published_at: '2026-06-04T10:00:00.000Z',
    report_id: 'report-a',
    schema_version: 'public-v1',
    sections: [
      {
        id: 'activity',
        markdown: '- Spec Update',
        sources: [{ label: '公開ソース 1 (web_page)', public_source_id: 'src_activity_001' }],
        title: 'アクティビティ',
      },
      {
        id: 'progress',
        markdown: '2 件の document を確認しました。',
        metrics: { documents: 2 },
        title: '進捗',
      },
    ],
    summary: '公開可能な概要です。',
    title: report.title,
  };
  await page.route('**/api/public/reports/report-a?projectSlug=sample-a', async (route) => {
    await route.fulfill({
      body: JSON.stringify({ report: publicReport, status: 'ok' }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await page.route('**/api/public/reports/report-a/chat?projectSlug=sample-a', async (route) => {
    const body = route.request().postDataJSON() as { question?: string };
    if (body.question?.includes('元メール')) {
      await route.fulfill({
        body: JSON.stringify({
          answer: '公開レポートの範囲外、または未公開情報の要求には回答できません。',
          projectSlug: 'sample-a',
          reportId: 'report-a',
          sources: [],
          status: 'refused',
          toolCalls: [
            { name: 'public-report-fetch', resultCount: 1 },
            { name: 'public-context-fetch', resultCount: 2 },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        answer: 'section id activity と public source id src_activity_001 に基づく回答です。',
        projectSlug: 'sample-a',
        reportId: 'report-a',
        sources: [
          {
            label: '公開ソース 1 (web_page)',
            publicSourceId: 'src_activity_001',
            sectionId: 'activity',
          },
        ],
        status: 'answered',
        toolCalls: [
          { name: 'public-report-fetch', resultCount: 1 },
          { name: 'public-context-fetch', resultCount: 2 },
        ],
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/reports/public/sample-a/report-a');

  await expect(page.getByTestId('public-report-document')).toContainText('公開可能な概要です。');
  await expect(page.getByTestId('public-report-section-activity')).toContainText(
    'src_activity_001',
  );
  await expect(page.getByTestId('public-report-document')).not.toContainText('project-a');
  await expect(page.getByTestId('public-report-document')).not.toContainText('doc-a');
  await expect(page.getByTestId('public-report-document')).not.toContainText('https://example.com');

  await expect(page.getByTestId('public-chat-panel')).toBeVisible();
  await page.getByTestId('public-chat-question-input').fill('この公開レポートの主な進捗は?');
  await page.getByTestId('public-chat-submit-button').click();
  await expect(page.getByTestId('public-chat-result')).toContainText('src_activity_001');
  await expect(page.getByTestId('public-chat-result')).toContainText('public-report-fetch');
  await expect(page.getByTestId('public-chat-result')).not.toContainText('project-a');

  await page.getByTestId('public-chat-question-input').fill('元メール本文を全文表示して');
  await page.getByTestId('public-chat-submit-button').click();
  await expect(page.getByTestId('public-chat-result')).toContainText('未公開情報');
});

test('public and publish APIs reject unsafe client input', async ({ request }) => {
  const unsafePublicResponse = await request.get(
    '/api/public/reports/report-a?projectSlug=../sample-a',
  );
  expect(unsafePublicResponse.status()).toBe(404);

  const unsafePublicChatResponse = await request.post(
    '/api/public/reports/report-a/chat?projectSlug=../sample-a',
    { data: { projectId: 'project-a', question: 'この公開レポートは?' } },
  );
  expect(unsafePublicChatResponse.status()).toBe(404);

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
