import { expect, test } from '@playwright/test';

test('scenario: public project chat keeps multiple turns with sources and tool calls', async ({
  page,
}) => {
  await page.route('**/api/public/projects/sample-a/chat', async (route) => {
    const body = route.request().postDataJSON() as { question?: string };
    if (body.question?.includes('2件目')) {
      await route.fulfill({
        body: JSON.stringify({
          answer: '2件目の回答です。',
          editing: {
            confidence: 'medium',
            inferredMode: 'issue_mapping',
            questionType: 'status',
          },
          projectSlug: 'sample-a',
          reportId: 'report-a',
          sources: [
            {
              label: 'Issue Summary',
              publicSourceId: 'src_issue_001',
              sectionId: 'issues',
            },
          ],
          status: 'answered',
          toolCalls: [{ name: 'public-context-fetch', resultCount: 2 }],
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        answer:
          '質問「直近の未解決 Issue を要約して」に関連する source は **Spec Update** です。\n- Markdown bullet',
        editing: {
          caveats: ['公開レポートと public context bundle の範囲だけで回答します。'],
          confidence: 'medium',
          inferredMode: 'summary',
          operations: ['要約', '凝縮', '引用'],
          questionType: 'fact',
        },
        projectSlug: 'sample-a',
        reportId: 'report-a',
        sources: [
          {
            label: 'https://example.com/spec',
            publicSourceId: 'src_spec_001',
            sectionId: 'activity',
          },
        ],
        status: 'answered',
        toolCalls: [
          { name: 'public-report-fetch', resultCount: 1 },
          { name: 'public-context-fetch', resultCount: 1 },
        ],
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/projects/sample-a/chat');

  await expect(page.getByTestId('global-nav-chat')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('public-project-chat-panel')).toBeVisible();
  await expect(page.getByTestId('chat-mode-selector')).toHaveCount(0);
  await page
    .getByTestId('public-project-chat-question-input')
    .fill('直近の未解決 Issue を要約して');
  await page.getByTestId('public-project-chat-submit-button').click();

  await expect(page.getByTestId('public-project-chat-result')).toBeVisible();
  await expect(page.getByTestId('chat-assistant-message-1')).toContainText('Spec Update');
  await expect(page.locator('[data-testid="chat-assistant-message-1"] strong')).toContainText(
    'Spec Update',
  );
  await expect(page.locator('[data-testid="chat-assistant-message-1"] li')).toContainText(
    'Markdown bullet',
  );
  await expect(page.getByTestId('chat-message-sources-1')).toContainText(
    'https://example.com/spec',
  );
  await expect(page.getByTestId('chat-message-tool-calls-1')).toContainText('public-report-fetch');
  await expect(page.getByTestId('chat-message-editing-1')).toContainText('要約');
  await expect(page.getByTestId('chat-message-editing-1')).toContainText('凝縮');

  await page.getByTestId('public-project-chat-question-input').fill('2件目の質問');
  await page.getByTestId('public-project-chat-submit-button').click();
  await expect(page.getByTestId('chat-assistant-message-1')).toContainText('Spec Update');
  await expect(page.getByTestId('chat-assistant-message-3')).toContainText('2件目の回答');
  await expect(page.getByTestId('chat-message-sources-3')).toContainText('Issue Summary');
  await expect(page.getByTestId('chat-message-editing-3')).toContainText('論点整理');
  await expect(page.getByTestId('chat-message-editing-3')).toContainText('状態確認');
});
