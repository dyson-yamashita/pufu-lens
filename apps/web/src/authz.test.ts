import assert from 'node:assert/strict';
import { parseProjectMemberAccess } from './authz.ts';

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

console.log('web authz tests passed');
