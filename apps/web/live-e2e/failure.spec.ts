import { expect, test } from '@playwright/test';

test('stopped workflow produces a visible error without a saved answer', async ({ page }) => {
  test.skip(
    process.env.PUFU_LENS_LIVE_CHAT_FAILURE_CHECK !== 'true',
    'Stop the dedicated Mastra server first.',
  );
  await page.goto('/login');
  await page.getByTestId('credentials-email-input').fill('e2e-chat-member@example.test');
  await page.getByTestId('credentials-password-input').fill('pufu-lens-e2e-chat-password');
  await page.getByTestId('credentials-login-button').click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto('/projects/local-dev/chat');
  const question = `SYNTH-UNAVAILABLE-${Date.now()}`;
  await page.getByTestId('chat-question-input').fill(question);
  await page.getByTestId('chat-submit-button').click();
  await expect(page.getByTestId('chat-assistant-message-1')).toContainText('エラー');
  await page.getByTestId('chat-question-input').fill('再試行用の質問');
  await expect(page.getByTestId('chat-submit-button')).toBeEnabled();
  const history = await page.request.get('/api/projects/local-dev/chat/history');
  expect(history.status()).toBe(200);
  expect(await history.text()).not.toContain(question);
});
