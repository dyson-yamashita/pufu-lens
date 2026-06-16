import assert from 'node:assert/strict';
import {
  parseAdminDbIdRow,
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

assert.equal(parseCanManageProjectRow({ can_manage: true }), true);
assert.equal(parseCanManageProjectRow({ can_manage: false }), false);
assert.throws(() => parseCanManageProjectRow(null), /Invalid project management access row/);
assert.throws(() => parseCanManageProjectRow([]), /Invalid project management access row/);
assert.throws(
  () => parseCanManageProjectRow({ can_manage: 'true' }),
  /Invalid project management access row/,
);

console.log('web admin db tests passed');
