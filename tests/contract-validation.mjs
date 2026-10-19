import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ strict: false, allErrors: true, multipleOfPrecision: 8 });
addFormats(ajv);
export const contracts = Object.fromEntries(['operation', 'lists', 'balances', 'reset', 'receipt'].map((name) => [name,
  ajv.compile(JSON.parse(readFileSync(new URL(`../contracts/mobile-${name}.schema.json`, import.meta.url), 'utf8'))),
]));
export function assertContract(name, value) {
  assert.equal(contracts[name](value), true, JSON.stringify(contracts[name].errors));
}
