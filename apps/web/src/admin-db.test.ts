import assert from 'node:assert/strict';
import {
  parseAdminDbAppMemberRow,
  parseAdminDbIdRow,
  parseAdminDbProjectMemberRow,
  parseAdminDbProjectRow,
  parseAdminDbPublicProjectReportRow,
  parseAppMemberRoleRow,
  parseCanManageProjectRow,
} from './admin-db-guards.ts';

const validProjectRow = {
  description: 'Sample project',
  failed_count: 0,
  held_count: 1,
  id: 'project-a',
  ingested_count: '10',
  last_indexed: new Date('2026-06-16T00:00:00.000Z'),
  member_count: 2n,
  name: 'Sample A',
  queue_count: 3,
  raw_count: 12,
  slug: 'sample-a',
  visibility: 'public',
};

assert.deepEqual(parseAdminDbProjectRow(validProjectRow), validProjectRow);
assert.throws(
  () => parseAdminDbProjectRow({ ...validProjectRow, visibility: 'internal' }),
  /Invalid project row field: visibility/,
);
assert.throws(
  () => parseAdminDbProjectRow({ ...validProjectRow, raw_count: null }),
  /Invalid project row field: raw_count/,
);

const validPublicProjectReportRow = {
  description: 'Public sample',
  name: 'Sample A',
  published_at: '2026-06-16T00:00:00.000Z',
  report_id: 'report-a',
  report_summary: 'Summary text',
  report_title: 'Report title',
  slug: 'sample-a',
};

assert.deepEqual(
  parseAdminDbPublicProjectReportRow(validPublicProjectReportRow),
  validPublicProjectReportRow,
);
assert.throws(
  () => parseAdminDbPublicProjectReportRow({ ...validPublicProjectReportRow, published_at: 123 }),
  /Invalid public project report row field: published_at/,
);
assert.throws(
  () => parseAdminDbPublicProjectReportRow({ ...validPublicProjectReportRow, report_id: 456 }),
  /Invalid public project report row field: report_id/,
);

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
