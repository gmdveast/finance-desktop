import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

// Stable calendar date, real elapsed milliseconds: retries and timeout deadlines still run.
export const TEST_INSTANT = process.env.FINANCE_TEST_INSTANT || '2026-10-16T09:00:00.000Z';
export function installTestClock() {
  process.env.TZ = 'Europe/Moscow';
  const NativeDate = globalThis.Date;
  const offset = NativeDate.parse(TEST_INSTANT) - NativeDate.now();
  const nativeStat = fs.stat;
  // File ages must use the same time domain as Date.now() (receipt retention).
  fs.stat = async (...args) => {
    const value = await nativeStat(...args);
    value.mtimeMs += offset;
    value.mtime = new NativeDate(value.mtimeMs);
    return value;
  };
  syncBuiltinESMExports();
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
    static now() { return NativeDate.now() + offset; }
  };
  return () => { globalThis.Date = NativeDate; fs.stat = nativeStat; syncBuiltinESMExports(); };
}
