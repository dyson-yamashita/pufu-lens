import { defineConfig, devices } from '@playwright/test';

const isCi = process.env.CI === 'true';
const useFixtureFallback = process.env.PUFU_LENS_ENABLE_FIXTURE_FALLBACK === 'true';
const databaseUrl = process.env.DATABASE_URL
  ? process.env.DATABASE_URL
  : useFixtureFallback
    ? undefined
    : 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens';
const storageDriver = process.env.STORAGE_DRIVER || 'local';
const storageRoot = process.env.STORAGE_ROOT || '../../infra/volumes/pufu-lens-data';

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
    },
  ],
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec next dev -p 3000',
    env: {
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      PUFU_LENS_ALLOW_FIXED_USER_FALLBACK: process.env.PUFU_LENS_ALLOW_FIXED_USER_FALLBACK || '',
      PUFU_LENS_ENABLE_FIXTURE_FALLBACK: process.env.PUFU_LENS_ENABLE_FIXTURE_FALLBACK || '',
      PUFU_LENS_REPORT_USER_ID: process.env.PUFU_LENS_REPORT_USER_ID || '',
      STORAGE_DRIVER: storageDriver,
      STORAGE_ROOT: storageRoot,
    },
    reuseExistingServer: !isCi,
    timeout: 30_000,
    url: 'http://localhost:3000/projects',
  },
});
