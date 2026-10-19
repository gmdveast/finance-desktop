import { test as base, expect } from '@playwright/test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export { expect };
export const test = base.extend({
  financeServer: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'finance-browser-'));
    const child = fork(new URL('./e2e-server.mjs', import.meta.url), [], {
      execArgv: [], env: { ...process.env, FINANCE_E2E_ROOT: directory }, silent: true,
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const server = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${output}`)), 15000);
        child.once('message', (message) => { clearTimeout(timer); resolve(message); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Fixture exit ${code}: ${output}`)); });
      });
      await use(server);
    } finally {
      if (child.connected) child.send('stop');
      const watchdog = setTimeout(() => child.kill(), 10000);
      await exited;
      clearTimeout(watchdog);
      await rm(directory, { recursive: true, force: true });
    }
  },
  baseURL: async ({ financeServer }, use) => use(financeServer.baseURL),
});
