import assert from 'node:assert/strict';
import { shouldProceedWithConfirm } from './form-confirm.ts';

assert.equal(shouldProceedWithConfirm(undefined), true);
assert.equal(
  shouldProceedWithConfirm(undefined, () => false),
  true,
);

assert.equal(
  shouldProceedWithConfirm('Delete this item?', () => true),
  true,
);
assert.equal(
  shouldProceedWithConfirm('Delete this item?', () => false),
  false,
);

console.log('form-buttons.test.ts passed');
