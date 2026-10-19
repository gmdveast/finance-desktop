import test from 'node:test';
import assert from 'node:assert/strict';
import { contracts, assertContract } from './contract-validation.mjs';
import { calendarDate, timestamp, numberField, rateField, rowId, publicError, createDiagnostics } from '../lib/input-boundary.mjs';

const operation = { schema: 1, id: 'event-123', author: 'Mobile', createdAt: '2026-10-17T09:00:00Z', operation: { date: '2026-10-17', type: 'Расход', category: 'Еда', amount: 0.000001, currency: 'RUB', accountId: 104 } };
const samples = {
  operation,
  lists: { schema: 1, lists: { accounts: [{ id: 104, name: 'Карта', currency: 'RUB' }] } },
  balances: { schema: 1, generatedAt: operation.createdAt, asOfDate: '2026-10-17', workbook: 'fixture.xlsx', accounts: [], rates: {}, missingRates: [], totalRub: 0 },
  reset: { schema: 1, cutoff: operation.createdAt, ids: ['event-123'] },
  receipt: { schema: 1, id: 'event-123', status: 'error', checkedAt: operation.createdAt, message: 'Ошибка' },
};
for (const [name, sample] of Object.entries(samples)) test(`schema ${name}: current and unknown version`, () => {
  assertContract(name, sample);
  assert.equal(contracts[name]({ ...sample, schema: 2 }), false);
});
test('operation schema rejects invalid dates, amounts and account IDs', () => {
  for (const patch of [{ date: '2026-02-30' }, { amount: 0 }, { amount: 1e9 }, { amount: 0.0000001 }, { amount: '1' }, { accountId: 105 }, { notes: 'x'.repeat(501) }]) {
    assert.equal(contracts.operation({ ...operation, operation: { ...operation.operation, ...patch } }), false, JSON.stringify(patch));
  }
  assertContract('lists', { schema: 1, lists: {}, futureField: true });
});
test('shared validators preserve precision and reject coercion and impossible dates', () => {
  assert.equal(calendarDate('2024-02-29'), true);
  for (const date of ['1900-02-29', '2026-04-31', '1899-12-31', null]) assert.equal(calendarDate(date), false);
  assert.equal(timestamp('2026-10-17T09:00:00+14:00'), true);
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-17T24:00:00Z', '2026-10-17T09:00:00+14:01']) assert.equal(timestamp(value), false);
  assert.equal(numberField('1,123456'), 1.123456);
  assert.equal(rateField(0.000000000001), 1e-12);
  assert.equal(rowId(104), 104);
  for (const value of [true, null, {}, '', Infinity, 1e9, 1.1234567]) assert.throws(() => numberField(value));
  assert.throws(() => rowId(true));
});
test('error classification and bounded diagnostics never disclose internal messages', () => {
  const { diagnose, recentDiagnostics } = createDiagnostics();
  for (const [properties, status] of [[{}, 500], [{ code: 'EBUSY' }, 503], [{ status: 409 }, 409], [{ status: 502 }, 502], [{ type: 'entity.parse.failed' }, 400]]) {
    const error = Object.assign(new Error('PRIVATE_PATH'), properties);
    assert.equal(publicError(error).status, status);
    assert.ok(!JSON.stringify(publicError(error)).includes('PRIVATE_PATH'));
  }
  for (let i = 0; i < 105; i++) diagnose(new Error('PRIVATE_PATH'));
  assert.equal(recentDiagnostics().length, 100);
  assert.ok(!JSON.stringify(recentDiagnostics()).includes('PRIVATE_PATH'));
  assert.equal(createDiagnostics().recentDiagnostics().length, 0);
});
