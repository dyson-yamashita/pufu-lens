import assert from 'node:assert/strict';
import {
  parseAppUserRoleRow,
  parseGlobalAdminIdRow,
  parseProjectMemberAccess,
  projectAccessSatisfiesRole,
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
assert.equal(projectAccessSatisfiesRole(parseProjectMemberAccess(validAccessRow), 'member'), true);
assert.equal(projectAccessSatisfiesRole(parseProjectMemberAccess(validAccessRow), 'admin'), true);

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

assert.equal(
  projectAccessSatisfiesRole(
    parseProjectMemberAccess({
      ...validAccessRow,
      projectRole: 'member',
    }),
    'admin',
  ),
  false,
);
assert.equal(
  projectAccessSatisfiesRole(
    parseProjectMemberAccess({
      ...validAccessRow,
      projectRole: null,
    }),
    'member',
  ),
  false,
);
assert.equal(
  projectAccessSatisfiesRole(
    parseProjectMemberAccess({
      ...validAccessRow,
      appRole: 'admin',
      projectRole: null,
    }),
    'admin',
  ),
  true,
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

assert.deepEqual(parseGlobalAdminIdRow({ id: 'admin-a' }), { id: 'admin-a' });
assert.throws(() => parseGlobalAdminIdRow(null), /Invalid global admin id row/);
assert.throws(() => parseGlobalAdminIdRow([]), /Invalid global admin id row/);
assert.throws(() => parseGlobalAdminIdRow({ id: 123 }), /Invalid global admin id row field: id/);

console.log('web authz tests passed');
