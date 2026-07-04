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
              publicSourceId: 'src_issues_1',
              sectionId: 'issues',
            },
          ],
          status: 'answered',
          toolCalls: [{ name: 'graph-query', resultCount: 2 }],
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
            label: 'Spec Update',
            publicSourceId: 'src_progress_1',
            sectionId: 'progress',
          },
        ],
        status: 'answered',
        toolCalls: [{ name: 'vector-search', resultCount: 2 }],
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
  const firstSources = page.getByTestId('chat-message-sources-1');
  const firstSourcesToggle = page.getByTestId('chat-message-sources-toggle-1');
  const firstSource = page.getByTestId('chat-message-source-1-src_progress_1');
  await expect(firstSources).toContainText('Sources (1)');
  await expect(firstSource).toBeHidden();
  await firstSourcesToggle.click();
  await expect(firstSource).toBeVisible();
  await expect(firstSources).toContainText('src_progress_1');
  await expect(firstSources).toContainText('Spec Update');
  await expect(firstSources).not.toContainText('https://example.com/spec');
  await expect(firstSources).not.toContainText('doc-spec-001');
  await expect(page.getByTestId('chat-message-tool-calls-1')).toContainText('vector-search');
  await expect(page.getByTestId('chat-message-editing-1')).toContainText('要約');
  await expect(page.getByTestId('chat-message-editing-1')).toContainText('凝縮');

  await page.getByTestId('public-project-chat-question-input').fill('2件目の質問');
  await page.getByTestId('public-project-chat-submit-button').click();
  await expect(page.getByTestId('chat-assistant-message-1')).toContainText('Spec Update');
  await expect(page.getByTestId('chat-assistant-message-3')).toContainText('2件目の回答');
  const secondSources = page.getByTestId('chat-message-sources-3');
  const secondSourcesToggle = page.getByTestId('chat-message-sources-toggle-3');
  const secondSource = page.getByTestId('chat-message-source-3-src_issues_1');
  await expect(secondSources).toContainText('Sources (1)');
  await expect(secondSource).toBeHidden();
  await secondSourcesToggle.click();
  await expect(secondSource).toBeVisible();
  await expect(secondSources).toContainText('src_issues_1');
  await expect(secondSources).toContainText('Issue Summary');
  await expect(secondSources).not.toContainText('raw-issue-001');
  await expect(page.getByTestId('chat-message-editing-3')).toContainText('論点整理');
  await expect(page.getByTestId('chat-message-editing-3')).toContainText('状態確認');
});

test('scenario: public project chat locks input outside database business hours', async ({
  page,
}) => {
  await page.route('**/api/public/projects/sample-a/chat', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        answer: 'db_outside_business_hours',
        projectSlug: 'sample-a',
        reportId: 'report-a',
        sources: [],
        status: 'db_outside_business_hours',
        toolCalls: [],
      }),
      contentType: 'application/json',
      status: 503,
    });
  });

  await page.goto('/projects/sample-a/chat');

  await page.getByTestId('public-project-chat-question-input').fill('営業時間外ですか');
  await page.getByTestId('public-project-chat-submit-button').click();

  await expect(page.getByTestId('public-project-chat-disabled-notice')).toHaveText(
    'db_outside_business_hours',
  );
  await expect(page.getByTestId('public-project-chat-question-input')).toBeDisabled();
  await expect(page.getByTestId('public-project-chat-submit-button')).toBeDisabled();
  await expect(page.getByTestId('public-project-chat-mic-button')).toBeDisabled();
});
