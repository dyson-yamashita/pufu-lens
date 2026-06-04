import { expect, test } from '@playwright/test';

test('chat page submits a question and renders sources and tool calls', async ({ page }) => {
  await page.route('**/api/projects/sample-a/chat', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        answer: '質問「直近の未解決 Issue を要約して」に関連する source は Spec Update です。',
        projectSlug: 'sample-a',
        sources: [
          {
            canonicalUri: 'https://example.com/spec',
            documentId: 'doc-a',
            docType: 'web_page',
            rawDocumentId: 'raw-a',
            title: 'Spec Update',
          },
        ],
        status: 'answered',
        toolCalls: [
          { name: 'vector-search', resultCount: 1 },
          { name: 'graph-query', resultCount: 1 },
          { name: 'document-fetch', resultCount: 1 },
        ],
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/chat');

  await expect(page.getByTestId('global-nav-chat')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await page.getByTestId('chat-question-input').fill('直近の未解決 Issue を要約して');
  await page.getByTestId('chat-submit-button').click();

  await expect(page.getByTestId('chat-result')).toBeVisible();
  await expect(page.getByTestId('chat-result')).toContainText('Spec Update');
  await expect(page.getByTestId('chat-result')).toContainText('https://example.com/spec');
  await expect(page.getByTestId('chat-result')).toContainText('vector-search: 1');
});
