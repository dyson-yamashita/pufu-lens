import assert from 'node:assert/strict';
import { hasProviderRecurrenceDelta } from './report-recurrence.ts';

assert.equal(hasProviderRecurrenceDelta(null), false);
assert.equal(hasProviderRecurrenceDelta(undefined), false);
assert.equal(
  hasProviderRecurrenceDelta({
    change_summary: 'summary',
    continued_items: [],
    decrements: [],
    increments: [],
  }),
  true,
);
assert.equal(
  hasProviderRecurrenceDelta({
    continued_items: [],
    decrements: [],
    increments: [],
  }),
  false,
);

console.log('report-recurrence.test.ts: ok');
