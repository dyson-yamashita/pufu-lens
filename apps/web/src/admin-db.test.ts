import assert from 'node:assert/strict';
import {
  parseAdminDbAppMemberRow,
  parseAdminDbIdRow,
  parseAdminDbProjectMemberRow,
  parseAppMemberRoleRow,
  parseCanManageProjectRow,
} from './admin-db-guards.ts';

assert.equal(parseAdminDbIdRow({ id: 'user-a' }, 'sample'), 'user-a');
assert.throws(() => parseAdminDbIdRow(null, 'sample'), /Invalid sample row/);
assert.throws(() => parseAdminDbIdRow([], 'sample'), /Invalid sample row/);
assert.throws(() => parseAdminDbIdRow({ id: 123 }, 'sample'), /Invalid sample row field: id/);
assert.throws(() => parseAdminDbIdRow({}, 'sample'), /Invalid sample row field: id/);

assert.equal(parseAppMemberRoleRow({ role: 'admin' }), 'admin');
assert.equal(parseAppMemberRoleRow({ role: 'member' }), 'member');
assert.throws(() => parseAppMemberRoleRow(null), /Invalid app member role row/);
assert.throws(() => parseAppMemberRoleRow([]), /Invalid app member role row/);
assert.throws(() => parseAppMemberRoleRow({ role: 'owner' }), /Invalid app member role row/);
assert.throws(() => parseAppMemberRoleRow({ role: null }), /Invalid app member role row/);

assert.deepEqual(
  parseAdminDbAppMemberRow({
    created_at: '2026-06-16T00:00:00.000Z',
    email: 'admin@example.test',
    id: 'user-a',
    name: null,
    role: 'admin',
  }),
  {
    created_at: '2026-06-16T00:00:00.000Z',
    email: 'admin@example.test',
    id: 'user-a',
    name: null,
    role: 'admin',
  },
);
assert.throws(
  () =>
    parseAdminDbAppMemberRow({
      created_at: '2026-06-16T00:00:00.000Z',
      email: 'admin@example.test',
      id: 'user-a',
      name: null,
      role: 'owner',
    }),
  /Invalid app member row field: role/,
);
assert.throws(
  () =>
    parseAdminDbAppMemberRow({
      created_at: null,
      email: 'admin@example.test',
      id: 'user-a',
      name: null,
      role: 'admin',
    }),
  /Invalid app member row field: created_at/,
);

assert.deepEqual(
  parseAdminDbProjectMemberRow({
    created_at: '2026-06-16T00:00:00.000Z',
    email: 'member@example.test',
    id: 'user-b',
    membership_created_at: null,
    name: 'Member B',
    project_role: 'member',
    removable: true,
    role: 'member',
  }),
  {
    created_at: '2026-06-16T00:00:00.000Z',
    email: 'member@example.test',
    id: 'user-b',
    membership_created_at: null,
    name: 'Member B',
    project_role: 'member',
    removable: true,
    role: 'member',
  },
);
assert.throws(
  () =>
    parseAdminDbProjectMemberRow({
      created_at: '2026-06-16T00:00:00.000Z',
      email: 123,
      id: 'user-b',
      membership_created_at: null,
      name: 'Member B',
      project_role: 'member',
      removable: true,
      role: 'member',
    }),
  /Invalid project member row field: email/,
);
assert.throws(
  () =>
    parseAdminDbProjectMemberRow({
      created_at: '2026-06-16T00:00:00.000Z',
      email: 'member@example.test',
      id: 'user-b',
      membership_created_at: null,
      name: 'Member B',
      project_role: 'owner',
      removable: true,
      role: 'member',
    }),
  /Invalid project member row field: project_role/,
);
assert.throws(
  () =>
    parseAdminDbProjectMemberRow({
      created_at: '2026-06-16T00:00:00.000Z',
      email: 'member@example.test',
      id: 'user-b',
      membership_created_at: null,
      name: 'Member B',
      project_role: 'member',
      removable: 'yes',
      role: 'member',
    }),
  /Invalid project member row field: removable/,
);
assert.throws(
  () =>
    parseAdminDbProjectMemberRow({
      created_at: '2026-06-16T00:00:00.000Z',
      email: 'member@example.test',
      id: 'user-b',
      membership_created_at: 123,
      name: 'Member B',
      project_role: 'member',
      removable: true,
      role: 'member',
    }),
  /Invalid project member row field: membership_created_at/,
);

assert.equal(parseCanManageProjectRow({ can_manage: true }), true);
assert.equal(parseCanManageProjectRow({ can_manage: false }), false);
assert.throws(() => parseCanManageProjectRow(null), /Invalid project management access row/);
assert.throws(() => parseCanManageProjectRow([]), /Invalid project management access row/);
assert.throws(
  () => parseCanManageProjectRow({ can_manage: 'true' }),
  /Invalid project management access row/,
);

console.log('web admin db tests passed');
