import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyPasswordCredential } from './password-auth.ts';

const passwordHash = await hashPassword('correct horse battery staple');
assert.equal(await verifyPassword('correct horse battery staple', passwordHash), true);
assert.equal(await verifyPassword('wrong password', passwordHash), false);
assert.equal(await verifyPassword('correct horse battery staple', 'invalid'), false);
assert.equal(await verifyPassword('correct horse battery staple', 'scrypt:v1:salt:'), false);
assert.doesNotMatch(passwordHash, /correct horse battery staple/);

const user = await verifyPasswordCredential(
  { email: ' OWNER@Example.com ', password: 'correct horse battery staple' },
  {
    async findPasswordCredential(email) {
      assert.equal(email, 'owner@example.com');
      return {
        email,
        id: 'user-owner',
        name: 'Owner',
        password_hash: passwordHash,
        role: 'member',
      };
    },
  },
);
assert.equal(user?.id, 'user-owner');

const rejected = await verifyPasswordCredential(
  { email: 'owner@example.com', password: 'wrong password' },
  {
    async findPasswordCredential() {
      return {
        email: 'owner@example.com',
        id: 'user-owner',
        name: 'Owner',
        password_hash: passwordHash,
        role: 'member',
      };
    },
  },
);
assert.equal(rejected, undefined);

const missingUser = await verifyPasswordCredential(
  { email: 'missing@example.com', password: 'whatever' },
  {
    async findPasswordCredential(email) {
      assert.equal(email, 'missing@example.com');
      return undefined;
    },
  },
);
assert.equal(missingUser, undefined);

console.log('web password auth tests passed');
