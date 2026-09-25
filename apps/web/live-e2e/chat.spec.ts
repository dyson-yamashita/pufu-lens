import { expect, test } from '@playwright/test';
import { liveChatCases } from '../../../scripts/lib/live-chat-corpus.ts';

type ObservedWindow = Window & { liveChatBody?: Promise<string> };

test('anonymous Chat request is rejected before invoking the workflow', async ({ request }) => {
  const response = await request.post('/api/projects/local-dev/chat', {
    data: { question: 'release 42 build 17 の承認者は誰ですか？' },
  });
  expect(response.status()).toBe(401);
});

for (const scenario of liveChatCases) {
  test(`live Chat: ${scenario.id}`, async ({ page }, testInfo) => {
    test.skip(!process.env.PUFU_LENS_LIVE_CHAT_MODE, 'Explicit live provider mode is required.');
    // Observe a clone of the real stream; no route interception or synthetic responses.
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (response.url.endsWith('/api/projects/local-dev/chat')) {
          (window as ObservedWindow).liveChatBody = response.clone().text();
        }
        return response;
      };
    });
    await page.goto('/login');
    await page.getByTestId('credentials-email-input').fill('e2e-chat-member@example.test');
    await page.getByTestId('credentials-password-input').fill('pufu-lens-e2e-chat-password');
    await page.getByTestId('credentials-login-button').click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.goto('/projects/local-dev/chat');
    const completed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/projects/local-dev/chat') &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('chat-question-input').fill(scenario.question);
    await page.getByTestId('chat-submit-button').click();
    const response = await completed;
    expect(response.status()).toBe(200);
    await page.waitForFunction(() => (window as ObservedWindow).liveChatBody !== undefined);
    const body = await page.evaluate(() => (window as ObservedWindow).liveChatBody);
    expect(body).toBeTruthy();
    const events = (body ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const result = events.find((event) => event.type === 'result')?.response;
    await testInfo.attach('live-chat-evidence', {
      body: JSON.stringify(
        { mode: process.env.PUFU_LENS_LIVE_CHAT_MODE, id: scenario.id, events },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(result?.status).toBe('answered');
    expect(events.some((event) => event.type === 'progress' && event.stage === 'reasoning')).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain('SYNTH-FOREIGN-SECRET');
    const titles = result.sources.map((source: { title: string }) => source.title);
    for (const title of scenario.requiredTitles) expect(titles).toContain(title);
    for (const fact of scenario.requiredFacts) expect(result.answer).toContain(fact);
    expect(result.toolCalls.map((call: { name: string }) => call.name)).toContain('hybrid-search');
    await expect(page.getByTestId('chat-assistant-message-1')).toContainText(
      scenario.requiredFacts[0],
    );
    await page.getByTestId('chat-message-sources-toggle-1').click();
    for (const title of scenario.requiredTitles) {
      await expect(page.getByTestId('chat-message-sources-1')).toContainText(title);
    }
    await page.reload();
    await page.getByTestId('chat-history-open-button').click();
    await expect(page.getByTestId('chat-history-list')).toContainText(scenario.question);
    await page
      .getByTestId('chat-history-list')
      .locator('button')
      .filter({ hasText: scenario.question })
      .first()
      .click();
    for (const fact of scenario.requiredFacts) {
      await expect(page.getByTestId('chat-assistant-message-1')).toContainText(fact);
    }
  });
}

test('member login and foreign project isolation use real Auth.js and DB', async ({ page }) => {
  await page.goto('/login');
  await page.getByTestId('credentials-email-input').fill('e2e-chat-member@example.test');
  await page.getByTestId('credentials-password-input').fill('pufu-lens-e2e-chat-password');
  await page.getByTestId('credentials-login-button').click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto('/projects/local-dev/chat');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  const response = await page.request.post('/api/projects/chat-e2e-foreign/chat', {
    data: { question: '非公開の承認コードを教えてください。' },
  });
  expect(response.status()).toBe(403);
});

test('live Chat: empty project does not invent evidence', async ({ page }, testInfo) => {
  test.skip(!process.env.PUFU_LENS_LIVE_CHAT_MODE, 'Explicit live provider mode is required.');
  await page.goto('/login');
  await page.getByTestId('credentials-email-input').fill('e2e-chat-member@example.test');
  await page.getByTestId('credentials-password-input').fill('pufu-lens-e2e-chat-password');
  await page.getByTestId('credentials-login-button').click();
  await expect(page).toHaveURL(/\/projects$/);
  const response = await page.request.post('/api/projects/chat-e2e-empty/chat', {
    data: {
      question: 'このプロジェクトの承認者と承認コードを教えてください。',
      includeHistory: false,
    },
    timeout: 150_000,
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  await testInfo.attach('live-chat-evidence', {
    body: JSON.stringify({ mode: process.env.PUFU_LENS_LIVE_CHAT_MODE, id: 'empty', result }),
    contentType: 'application/json',
  });
  expect(result.status).toBe('answered');
  expect(result.sources).toEqual([]);
  expect(result.answer).toMatch(/(情報|資料|確認|見つ|特定)/);
  expect(result.answer).not.toContain('SYNTH-');
});
