import { defineConfig, devices } from '@playwright/test';

/** Runs opt-in live Chat checks against manually started local Web and Mastra servers. */
export default defineConfig({
  testDir: './live-e2e',
  timeout: 180_000,
  expect: { timeout: 120_000 },
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    [
      'json',
      { outputFile: process.env.PUFU_LENS_LIVE_CHAT_REPORT || '/tmp/pufu-live-chat-report.json' },
    ],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3771',
    trace: 'retain-on-failure',
  },
});
