import { expect, test } from '@playwright/test';
import { liveChatCases } from '../../../scripts/lib/live-chat-corpus.ts';

const reportId = '11111111-1111-4111-8111-111111111111';
const privateReportId = '22222222-2222-4222-8222-222222222222';
type ObservedWindow = Window & { publicChatBody?: Promise<string> };

test.beforeEach(() => {
  test.skip(!process.env.PUFU_LENS_LIVE_CHAT_MODE, 'Explicit live provider mode is required.');
});

for (const scenario of liveChatCases) {
  test(`live public Chat: ${scenario.id}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (response.url.endsWith('/api/public/projects/local-dev/chat')) {
          (window as ObservedWindow).publicChatBody = response.clone().text();
        }
        return response;
      };
    });
    await page.goto('/projects/local-dev/chat');
    await expect(page.getByTestId('public-project-chat-panel')).toBeVisible();
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
    const completed = page.waitForResponse((response) =>
      response.url().endsWith('/api/public/projects/local-dev/chat'),
    );
    await page.getByTestId('public-project-chat-question-input').fill(scenario.question);
    await page.getByTestId('public-project-chat-submit-button').click();
    expect((await completed).status()).toBe(200);
    await page.waitForFunction(() => (window as ObservedWindow).publicChatBody !== undefined);
    const body = await page.evaluate(() => (window as ObservedWindow).publicChatBody);
    const events = (body ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const result = events.find((event) => event.type === 'result')?.response;
    await testInfo.attach('live-public-chat-evidence', {
      body: JSON.stringify({ mode: process.env.PUFU_LENS_LIVE_CHAT_MODE, id: scenario.id, events }),
      contentType: 'application/json',
    });
    expect(result?.status).toBe('answered');
    expect(result.reportId).toBe(reportId);
    expect(events.some((event) => event.type === 'progress' && event.stage === 'reasoning')).toBe(
      true,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SYNTH-FOREIGN-SECRET');
    expect(serialized).not.toMatch(
      /"(?:documentId|rawDocumentId|chunkId|chunkIndex|canonicalUri|snippet|graphCoverage|document_id|raw_document_id)"\s*:/,
    );
    expect(result.answer).not.toMatch(
      /workflow_retrieval|graphCoverage|relationAdoptedCounts|GitHub.*(?:ライフサイクル|lifecycle)|グラフ(?:ステータス|カバレッジ)|採用された関係数|シード数/,
    );
    for (const fact of scenario.requiredFacts) {
      if (fact === '方式B') expect(result.answer).toMatch(/方式B|方式(?:が)?AからBへ/);
      else expect(result.answer).toContain(fact);
    }
    for (const source of result.sources) {
      expect(Object.keys(source).sort()).toEqual(['label', 'publicSourceId', 'sectionId']);
      expect(source.publicSourceId).toMatch(/^src_progress_\d+$/);
    }
    await expect(page.getByTestId('chat-assistant-message-1')).toContainText(
      scenario.requiredFacts[0],
    );
    await page.getByTestId('chat-message-sources-toggle-1').click();
    for (const title of scenario.requiredTitles) {
      expect(result.sources.map((source: { label: string }) => source.label)).toContain(title);
      await expect(page.getByTestId('chat-message-sources-1')).toContainText(title);
    }
    expect(result.toolCalls.map((call: { name: string }) => call.name)).toContain('hybrid-search');
    if (scenario.id === 'japanese-typo')
      await page.screenshot({ path: testInfo.outputPath('public-answer.png'), fullPage: true });
  });
}

test('live public report API returns JSON with public source IDs', async ({
  request,
}, testInfo) => {
  const response = await request.post(`/api/public/projects/local-dev/reports/${reportId}/chat`, {
    data: { question: liveChatCases[0].question },
    timeout: 150_000,
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  await testInfo.attach('live-public-chat-evidence', {
    body: JSON.stringify({ mode: process.env.PUFU_LENS_LIVE_CHAT_MODE, id: 'report-json', result }),
    contentType: 'application/json',
  });
  expect(result.status).toBe('answered');
  for (const fact of liveChatCases[0].requiredFacts) expect(result.answer).toContain(fact);
  expect(result.sources).toContainEqual({
    label: liveChatCases[0].requiredTitles[0],
    publicSourceId: 'src_progress_1',
    sectionId: 'progress',
  });
  expect(JSON.stringify(result)).not.toContain('SYNTH-FOREIGN-SECRET');
});

test('live public Chat rejects private projects and unpublished reports', async ({ request }) => {
  for (const path of [
    '/api/public/projects/chat-e2e-foreign/chat',
    `/api/public/projects/local-dev/reports/${privateReportId}/chat`,
    `/api/public/projects/chat-e2e-foreign/reports/${reportId}/chat`,
  ]) {
    const response = await request.post(path, {
      data: { question: '承認コードを教えてください。' },
    });
    expect(response.status()).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('SYNTH-');
  }
});

test('live public Chat without a published report does not invent evidence', async ({
  request,
}) => {
  const response = await request.post('/api/public/projects/chat-e2e-empty/chat', {
    data: { question: '承認コードを教えてください。' },
  });
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.status).toBe('no_public_report');
  expect(result.sources).toEqual([]);
  expect(result.toolCalls).toEqual([]);
  expect(result.answer).not.toContain('SYNTH-');
});

test('published synthetic report renders from real local artifacts', async ({ page }) => {
  await page.goto(`/reports/public/local-dev/${reportId}`);
  await expect(page.getByTestId('public-report-document')).toContainText(
    '実Chat評価用の合成公開レポート',
  );
  await expect(page.getByTestId('public-report-document')).toContainText('合成資料の一覧です。');
  await expect(page.getByTestId('public-report-status')).toHaveCount(0);
});
