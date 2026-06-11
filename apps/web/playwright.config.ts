import { defineConfig, devices } from '@playwright/test';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens';
const storageDriver = process.env.STORAGE_DRIVER ?? 'local';
const storageRoot = process.env.STORAGE_ROOT ?? '../../infra/volumes/pufu-lens-data';

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
      DATABASE_URL: databaseUrl,
      STORAGE_DRIVER: storageDriver,
      STORAGE_ROOT: storageRoot,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    url: 'http://localhost:3000/projects',
  },
});
