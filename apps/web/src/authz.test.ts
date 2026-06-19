import assert from 'node:assert/strict';
import {
  parseAppUserRoleRow,
  parseGlobalAdminCountRow,
  parseProjectMemberAccess,
} from './authz.ts';

const validAccessRow = {
  appRole: 'member',
  description: 'Sample description',
  graphName: 'graph_sample',
  id: 'project-a',
  name: 'Sample Project',
  projectRole: 'admin',
  slug: 'sample',
  visibility: 'private',
};

assert.deepEqual(parseProjectMemberAccess(validAccessRow), validAccessRow);

assert.deepEqual(
  parseProjectMemberAccess({
    ...validAccessRow,
    appRole: 'admin',
    description: null,
    graphName: null,
    projectRole: null,
    visibility: 'public',
  }),
  {
    ...validAccessRow,
    appRole: 'admin',
    description: null,
    graphName: null,
    projectRole: null,
    visibility: 'public',
  },
);

assert.throws(
  () => parseProjectMemberAccess({ ...validAccessRow, description: 123 }),
  /Invalid project member access field: description/,
);

assert.throws(() => parseProjectMemberAccess(null), /Invalid project member access row/);
assert.throws(() => parseProjectMemberAccess([]), /Invalid project member access row/);
assert.throws(
  () => parseProjectMemberAccess({ ...validAccessRow, appRole: 'owner' }),
  /Invalid project member access field: appRole/,
);
assert.throws(
  () => parseProjectMemberAccess({ ...validAccessRow, graphName: 123 }),
  /Invalid project member access field: graphName/,
);
assert.throws(
  () => parseProjectMemberAccess({ ...validAccessRow, projectRole: 'owner' }),
  /Invalid project member access field: projectRole/,
);
assert.throws(
  () => parseProjectMemberAccess({ ...validAccessRow, visibility: 'internal' }),
  /Invalid project member access field: visibility/,
);

assert.equal(parseAppUserRoleRow({ role: 'admin' }), 'admin');
assert.equal(parseAppUserRoleRow({ role: 'member' }), 'member');
assert.throws(() => parseAppUserRoleRow(null), /Invalid app user role row/);
assert.throws(() => parseAppUserRoleRow([]), /Invalid app user role row/);
assert.throws(
  () => parseAppUserRoleRow({ role: 'owner' }),
  /Invalid app user role row field: role/,
);
assert.throws(() => parseAppUserRoleRow({ role: null }), /Invalid app user role row field: role/);

assert.equal(parseGlobalAdminCountRow({ admin_count: 2 }), 2);
assert.equal(parseGlobalAdminCountRow({ admin_count: 4n }), 4);
assert.equal(parseGlobalAdminCountRow({ admin_count: '3' }), 3);
assert.throws(
  () => parseGlobalAdminCountRow({ admin_count: 'many' }),
  /Invalid global admin count row field: admin_count/,
);
assert.throws(() => parseGlobalAdminCountRow(null), /Invalid global admin count row/);

console.log('web authz tests passed');
