import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityPubAdminError } from './activitypub-admin.ts';
import { parseFederationEnabledFormValue } from './activitypub-federation-form.ts';

test('parseFederationEnabledFormValue accepts exact true and false strings', () => {
  assert.equal(parseFederationEnabledFormValue('true'), true);
  assert.equal(parseFederationEnabledFormValue('false'), false);
});

test('parseFederationEnabledFormValue rejects invalid enabled values', () => {
  for (const value of ['', 'yes', '1', 'TRUE', ' false']) {
    assert.throws(() => parseFederationEnabledFormValue(value), ActivityPubAdminError);
  }
});
