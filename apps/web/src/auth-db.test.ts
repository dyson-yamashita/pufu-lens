import assert from 'node:assert/strict';
import {
  AuthAccountLinkError,
  type AuthUserRecord,
  type AuthUserRepository,
  resolveAuthUser,
} from './auth-db.ts';

function createRepository(seedUsers: readonly AuthUserRecord[] = []): AuthUserRepository & {
  readonly accounts: Map<string, string>;
  readonly users: Map<string, AuthUserRecord>;
} {
  const users = new Map(seedUsers.map((user) => [user.id, user]));
  const accounts = new Map<string, string>();

  return {
    accounts,
    users,
    async createUser({ email, name }) {
      const user = {
        email,
        id: `user-${users.size + 1}`,
        name,
        role: 'member' as const,
      };
      users.set(user.id, user);
      return user;
    },
    async findAccountUser({ provider, providerAccountId }) {
      const userId = accounts.get(`${provider}:${providerAccountId}`);
      return userId ? users.get(userId) : undefined;
    },
    async findUserByEmail(email) {
      return [...users.values()].find((user) => user.email === email);
    },
    async linkAccount({ provider, providerAccountId, userId }) {
      accounts.set(`${provider}:${providerAccountId}`, userId);
    },
    async updateUserProfile({ email, name, userId }) {
      const user = users.get(userId);
      assert.ok(user);
      users.set(userId, { ...user, email, name });
    },
  };
}

const newUserRepository = createRepository();
const newUser = await resolveAuthUser(
  {
    email: ' New.User@Example.com ',
    emailVerified: false,
    name: 'New User',
    provider: 'github',
    providerAccountId: 'gh-1',
  },
  newUserRepository,
);
assert.equal(newUser.email, 'new.user@example.com');
assert.equal(newUser.role, 'member');
assert.equal(newUserRepository.accounts.get('github:gh-1'), newUser.id);

const existingRepository = createRepository([
  { email: 'owner@example.com', id: 'user-owner', name: 'Owner', role: 'member' },
]);
await assert.rejects(
  () =>
    resolveAuthUser(
      {
        email: 'owner@example.com',
        emailVerified: false,
        name: 'Imposter',
        provider: 'github',
        providerAccountId: 'gh-2',
      },
      existingRepository,
    ),
  AuthAccountLinkError,
);
assert.equal(existingRepository.accounts.has('github:gh-2'), false);

const linkedUser = await resolveAuthUser(
  {
    email: 'owner@example.com',
    emailVerified: true,
    name: 'Verified Owner',
    provider: 'google',
    providerAccountId: 'google-1',
  },
  existingRepository,
);
assert.equal(linkedUser.id, 'user-owner');
assert.equal(linkedUser.name, 'Verified Owner');
assert.equal(existingRepository.accounts.get('google:google-1'), 'user-owner');

const returningUser = await resolveAuthUser(
  {
    email: 'updated@example.com',
    emailVerified: false,
    name: 'Updated Owner',
    provider: 'google',
    providerAccountId: 'google-1',
  },
  existingRepository,
);
assert.equal(returningUser.id, 'user-owner');
assert.equal(returningUser.email, 'updated@example.com');
assert.equal(returningUser.name, 'Updated Owner');
assert.equal(existingRepository.users.get('user-owner')?.email, 'updated@example.com');
assert.equal(existingRepository.users.get('user-owner')?.name, 'Updated Owner');

console.log('web auth db tests passed');
