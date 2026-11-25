import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4175';
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'corepack pnpm@12.23.0 exec vite --host 127.0.0.1 --port 4175 --strictPort',
    cwd: process.cwd(),
    url: baseURL,
    reuseExistingServer: false,
    env: { ...process.env, API_PROXY_TARGET: apiTarget },
    timeout: 60_000,
  },
});
