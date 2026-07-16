import { createServer, type IncomingMessage, type Server } from 'node:http';
import { expect, type Locator, test } from '@playwright/test';

const privateChatCredentials = {
  email: process.env.PUFU_LENS_E2E_CHAT_EMAIL,
  password: process.env.PUFU_LENS_E2E_CHAT_PASSWORD,
};

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
  await expect(page.getByTestId('public-chat-assistant-intro-message')).toContainText(
    'プロジェクト Sample A  についてご質問ください。',
  );
  await expect(page.getByTestId('public-chat-assistant-intro-message')).toContainText(
    '例： Sample A  について教えてください。',
  );
  await expect(page.getByTestId('chat-mode-selector')).toHaveCount(0);
  await page
    .getByTestId('public-project-chat-question-input')
    .fill('直近の未解決 Issue を要約して');
  await page.getByTestId('public-project-chat-question-input').press('Control+Enter');

  await expect(page.getByTestId('public-project-chat-result')).toBeVisible();
  await expect(page.getByTestId('public-chat-intro-message')).toHaveCount(0);
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

test('scenario: public project chat input grows with content up to four rows', async ({ page }) => {
  await page.goto('/projects/sample-a/chat');

  await assertChatInputAutosizes(page.getByTestId('public-project-chat-question-input'));
});

test('scenario: public project chat input grows with content up to four rows @mobile', async ({
  page,
}) => {
  await page.goto('/projects/sample-a/chat');

  await assertChatInputAutosizes(page.getByTestId('public-project-chat-question-input'));
});

test('scenario: member sends private chat and reads persisted history from fixture DB', async ({
  page,
}) => {
  test.skip(
    !process.env.DATABASE_URL || !privateChatCredentials.email || !privateChatCredentials.password,
    'DATABASE_URL, PUFU_LENS_E2E_CHAT_EMAIL, and PUFU_LENS_E2E_CHAT_PASSWORD are required.',
  );

  const mastraServer = await startMastraChatStub();
  const question = `E2E private chat write ${Date.now()}`;
  const answer = `E2E private chat persisted answer for: ${question}`;

  try {
    await page.goto('/login');
    await page.getByTestId('credentials-email-input').fill(privateChatCredentials.email ?? '');
    await page
      .getByTestId('credentials-password-input')
      .fill(privateChatCredentials.password ?? '');
    await page.getByTestId('credentials-login-button').click();
    await expect(page).toHaveURL(/\/projects$/);

    await page.goto('/projects/local-dev/chat');
    await expect(page.getByTestId('chat-panel')).toBeVisible();
    await expect(page.getByTestId('public-project-chat-panel')).toHaveCount(0);

    await page.getByTestId('chat-question-input').fill(question);
    await page.getByTestId('chat-submit-button').click();
    const stage = page.getByTestId('chat-assistant-message-1-stage');
    await expect(stage).toBeVisible();
    await expect(stage).toHaveText('質問の見方を整理しています');
    await expect(stage).toHaveText('検索語を展開しています');
    await expect(stage).toHaveText('関連資料を検索しています');
    await expect(stage).toHaveAttribute('aria-live', 'polite');
    await expect(page.getByTestId('chat-assistant-message-1')).toContainText(answer);
    await expect(page.getByTestId('chat-message-tool-calls-1')).toContainText('vector-search');

    await page.reload();
    await expect(page.getByTestId('chat-panel')).toBeVisible();
    await page.getByTestId('chat-history-open-button').click();
    await expect(page.getByTestId('chat-history-dialog')).toBeVisible();
    await expect(page.getByTestId('chat-history-list')).toContainText(question);
    await expect(page.getByTestId('chat-history-list')).toContainText(answer);

    await page
      .getByTestId('chat-history-list')
      .locator('button')
      .filter({ hasText: question })
      .click();
    await expect(page.getByTestId('chat-user-message-0')).toContainText(question);
    await expect(page.getByTestId('chat-assistant-message-1')).toContainText(answer);
  } finally {
    await closeServer(mastraServer);
  }
});

async function assertChatInputAutosizes(input: Locator): Promise<void> {
  await expect(input).toBeVisible();
  const initialHeight = await textareaClientHeight(input);

  await input.click();
  await expect.poll(() => textareaClientHeight(input)).toBeLessThanOrEqual(initialHeight + 1);

  await input.fill('1行目\n2行目');
  await expect.poll(() => textareaClientHeight(input)).toBeGreaterThan(initialHeight + 10);
  const twoRowHeight = await textareaClientHeight(input);

  await input.fill('1行目\n2行目\n3行目\n4行目');
  let fourRowHeight = 0;
  await expect
    .poll(async () => {
      fourRowHeight = await textareaClientHeight(input);
      return fourRowHeight;
    })
    .toBeGreaterThan(twoRowHeight + 10);

  await input.fill('1行目\n2行目\n3行目\n4行目\n5行目\n6行目');
  await expect.poll(() => textareaClientHeight(input)).toBeLessThanOrEqual(fourRowHeight + 4);
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const textarea =
          element instanceof HTMLTextAreaElement ? element : element.querySelector('textarea');
        if (!textarea) {
          throw new Error('Expected chat input locator to resolve to a textarea.');
        }
        return textarea.scrollHeight > textarea.clientHeight;
      }),
    )
    .toBe(true);
}

async function textareaClientHeight(input: Locator): Promise<number> {
  return input.evaluate((element) => {
    const textarea =
      element instanceof HTMLTextAreaElement ? element : element.querySelector('textarea');
    if (!textarea) {
      throw new Error('Expected chat input locator to resolve to a textarea.');
    }
    return textarea.clientHeight;
  });
}

async function startMastraChatStub(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const url = request.url ?? '';
      if (request.method === 'POST' && url === '/api/workflows/private-chat-search/create-run') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ runId: 'e2e-private-chat-run' }));
        return;
      }

      if (
        request.method === 'POST' &&
        url.startsWith('/api/workflows/private-chat-search/stream?runId=')
      ) {
        const body = await readJsonBody(request);
        const question =
          typeof body.inputData === 'object' &&
          body.inputData !== null &&
          'question' in body.inputData &&
          typeof body.inputData.question === 'string'
            ? body.inputData.question
            : '';
        const chatResponse = {
          answer: `E2E private chat persisted answer for: ${question}`,
          projectSlug: 'local-dev',
          sources: [
            {
              canonicalUri: 'https://example.test/e2e/private-chat',
              docType: 'web',
              documentId: 'e2e-private-chat-doc',
              rawDocumentId: 'e2e-private-chat-raw',
              snippet: 'E2E private chat source snippet',
              title: 'E2E private chat source',
            },
          ],
          status: 'answered',
          toolCalls: [{ name: 'vector-search', resultCount: 1 }],
        };
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.write(
          `${JSON.stringify({ payload: { id: 'private-chat-classifying' }, type: 'workflow-step-start' })}\x1e`,
        );
        // Keep transient stages visible long enough for the browser assertion to
        // observe each streamed workflow transition on slower CI runners.
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        response.write(
          `${JSON.stringify({ payload: { id: 'private-chat-expanding' }, type: 'workflow-step-start' })}\x1e`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        response.write(
          `${JSON.stringify({ payload: { id: 'private-chat-retrieving' }, type: 'workflow-step-start' })}\x1e`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        response.end(
          JSON.stringify({
            payload: { id: 'private-chat-synthesis', output: chatResponse },
            type: 'workflow-step-result',
          }),
        );
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      console.error('Mastra stub error:', error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'internal_server_error' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4111, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
