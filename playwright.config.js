import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Inherited by workers; concurrent runs must not remove each other's traces.
const runId = process.env.FINANCE_TEST_RUN_ID ||= randomUUID();

export default defineConfig({
  testDir: './tests',
  outputDir: `test-results/${runId}`,
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${runId}` }]],
  use: {
    headless: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
