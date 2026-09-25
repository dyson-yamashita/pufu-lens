import { expect, test } from '@playwright/test';

const scenarios = [
  {
    id: 'raw',
    question:
      'ガラス保管手順の原文を開き、原文限定の点検規則に書かれた点検曜日と点検確認コードを教えてください。検索の要約に無い情報は原文で確認してください。',
    facts: ['水曜', 'SYNTH-RAW-GLASS-91'],
    tool: 'raw-document-fetch',
  },
  {
    id: 'graph',
    question:
      'ガラス保管手順だけを起点にグラフの関連資料を確認してください。関連資料として80% 警告設定は見つかりますか。資料の通知先も教えてください。',
    facts: ['80% 警告設定', '若葉班'],
    tool: 'graph-query',
  },
] as const;

for (const scenario of scenarios) {
  test(`live Chat details: ${scenario.id}`, async ({ page }, testInfo) => {
    test.skip(!process.env.PUFU_LENS_LIVE_CHAT_MODE, 'Explicit live mode required.');
    await page.goto('/login');
    await page.getByTestId('credentials-email-input').fill('e2e-chat-member@example.test');
    await page.getByTestId('credentials-password-input').fill('pufu-lens-e2e-chat-password');
    await page.getByTestId('credentials-login-button').click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.goto('/projects/local-dev/chat');
    // JSON response exercises the same real workflow; the browser displays the saved history.
    const response = await page.request.post('/api/projects/local-dev/chat', {
      data: { question: scenario.question, includeHistory: false },
      timeout: 150_000,
    });
    expect(response.status()).toBe(200);
    const result = await response.json();
    await testInfo.attach('live-chat-details-evidence', {
      body: JSON.stringify({ mode: process.env.PUFU_LENS_LIVE_CHAT_MODE, id: scenario.id, result }),
      contentType: 'application/json',
    });
    expect(result.status).toBe('answered');
    for (const fact of scenario.facts) expect(result.answer).toContain(fact);
    expect(
      result.toolCalls.some(
        (call: { name: string; resultCount: number }) =>
          call.name === scenario.tool && call.resultCount > 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SYNTH-FOREIGN-SECRET');
    await page.reload();
    await page.getByTestId('chat-history-open-button').click();
    await page
      .getByTestId('chat-history-list')
      .locator('button')
      .filter({ hasText: scenario.question })
      .first()
      .click();
    for (const fact of scenario.facts)
      await expect(page.getByTestId('chat-assistant-message-1')).toContainText(fact);
  });
}

test('live Mastra parsed metadata tool returns real project-scoped records', async ({
  request,
}, testInfo) => {
  test.skip(!process.env.PUFU_LENS_LIVE_CHAT_MODE, 'Explicit live mode required.');
  const projectId = process.env.PUFU_LENS_LIVE_CHAT_PROJECT_ID;
  const foreignId = process.env.PUFU_LENS_LIVE_CHAT_FOREIGN_PROJECT_ID;
  expect(projectId).toBeTruthy();
  expect(foreignId).toBeTruthy();
  for (const [id, expectedCount] of [
    [projectId, 6],
    [foreignId, 0],
  ] as const) {
    const response = await request.post(
      'http://127.0.0.1:4771/api/tools/parsed-doc-fetch/execute',
      {
        data: { data: { limit: 10 }, requestContext: { projectId: id } },
      },
    );
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.sources).toHaveLength(expectedCount);
    expect(JSON.stringify(result)).not.toContain('SYNTH-RAW-GLASS-91');
    await testInfo.attach('live-parsed-metadata-evidence', {
      body: JSON.stringify({
        scope: id === projectId ? 'local' : 'foreign',
        sources: result.sources.map((source: { title: string; snippet: string }) => ({
          title: source.title,
          snippet: source.snippet,
        })),
      }),
      contentType: 'application/json',
    });
    if (id === projectId)
      expect(result.sources.map((source: { title: string }) => source.title)).toContain(
        'ガラス保管手順',
      );
  }
});
