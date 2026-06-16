import assert from 'node:assert/strict';
import {
  parseAdminActionAdminCountRow,
  parseAdminActionDataSourceIngestRow,
  parseAdminActionDataSourceRow,
  parseAdminActionIdRow,
  parseAdminActionParserVersionRow,
  parseAdminActionProjectRow,
} from './admin-actions-guards.ts';

assert.deepEqual(parseAdminActionIdRow({ id: 'row-a' }, 'sample row'), { id: 'row-a' });
assert.throws(() => parseAdminActionIdRow(null, 'sample row'), /Invalid sample row/);
assert.throws(
  () => parseAdminActionIdRow({ id: 123 }, 'sample row'),
  /Invalid sample row field: id/,
);

assert.deepEqual(
  parseAdminActionProjectRow({
    admin_user_id: 'user-a',
    description: null,
    id: 'project-a',
    name: 'Project A',
    slug: 'project-a',
    visibility: 'private',
  }),
  {
    admin_user_id: 'user-a',
    description: null,
    id: 'project-a',
    name: 'Project A',
    slug: 'project-a',
    visibility: 'private',
  },
);
assert.throws(
  () =>
    parseAdminActionProjectRow({
      admin_user_id: 'user-a',
      description: null,
      id: 'project-a',
      name: 'Project A',
      slug: 'project-a',
      visibility: 'internal',
    }),
  /Invalid admin project row field: visibility/,
);

assert.deepEqual(parseAdminActionDataSourceRow({ id: 'source-a', source_type: 'github' }), {
  id: 'source-a',
  source_type: 'github',
});
assert.throws(
  () => parseAdminActionDataSourceRow({ id: 'source-a', source_type: 'slack' }),
  /Invalid admin data source row field: source_type/,
);

assert.deepEqual(
  parseAdminActionDataSourceIngestRow({
    id: 'source-a',
    source_type: 'drive',
    storage_uri: null,
  }),
  { id: 'source-a', source_type: 'drive', storage_uri: null },
);
assert.throws(
  () =>
    parseAdminActionDataSourceIngestRow({
      id: 'source-a',
      source_type: 'drive',
      storage_uri: 123,
    }),
  /Invalid admin data source ingest row field: storage_uri/,
);

assert.equal(parseAdminActionAdminCountRow({ admin_count: 2 }), 2);
assert.equal(parseAdminActionAdminCountRow({ admin_count: '3' }), 3);
assert.throws(
  () => parseAdminActionAdminCountRow({ admin_count: 'many' }),
  /Invalid admin count row field: admin_count/,
);

assert.deepEqual(parseAdminActionParserVersionRow({ id: 'version-a', status: 'draft' }), {
  id: 'version-a',
  status: 'draft',
});
assert.throws(
  () => parseAdminActionParserVersionRow({ id: 'version-a', status: null }),
  /Invalid parser version row field: status/,
);

console.log('web admin actions guards tests passed');
