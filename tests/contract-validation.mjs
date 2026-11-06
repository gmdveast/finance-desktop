import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ strict: false, allErrors: true, multipleOfPrecision: 8 });
addFormats(ajv);
const contractFiles = {
  operation: 'operation',
  operationV2: 'operation-v2',
  lists: 'lists',
  balances: 'balances',
  reset: 'reset',
  receipt: 'receipt',
};
export const contracts = Object.fromEntries(Object.entries(contractFiles).map(([name, file]) => [name,
  ajv.compile(JSON.parse(readFileSync(new URL(`../contracts/mobile-${file}.schema.json`, import.meta.url), 'utf8'))),
]));
export function assertContract(name, value) {
  assert.equal(contracts[name](value), true, JSON.stringify(contracts[name].errors));
}
