import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOAuthConnectionRow } from './collection-connection-row-parsers.ts';

test('parseOAuthConnectionRow accepts github installation connection rows', () => {
  const row = parseOAuthConnectionRow({
    accessTokenSecret: null,
    expiresAt: null,
    id: '00000000-0000-0000-0000-000000000101',
    metadata: { installationId: '12345', status: 'connected' },
    provider: 'github',
    refreshTokenSecret: null,
    userId: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(row.provider, 'github');
  assert.equal(row.id, '00000000-0000-0000-0000-000000000101');
});

test('parseOAuthConnectionRow rejects invalid providers', () => {
  assert.throws(
    () =>
      parseOAuthConnectionRow({
        id: '00000000-0000-0000-0000-000000000101',
        metadata: {},
        provider: 'slack',
        userId: '00000000-0000-0000-0000-000000000001',
      }),
    /Invalid oauth connection provider/,
  );
});
