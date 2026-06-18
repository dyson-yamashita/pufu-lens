import assert from 'node:assert/strict';
import {
  parseAdminDbAppMemberRow,
  parseAdminDbIdRow,
  parseAdminDbOAuthConnectionRow,
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
assert.throws(
  () => parseAdminDbProjectRow({ ...validProjectRow, raw_count: 'many' }),
  /Invalid project row field: raw_count/,
);
assert.throws(
  () => parseAdminDbProjectRow({ ...validProjectRow, raw_count: -1 }),
  /Invalid project row field: raw_count/,
);
assert.throws(
  () => parseAdminDbProjectRow({ ...validProjectRow, raw_count: 1.5 }),
  /Invalid project row field: raw_count/,
);
assert.throws(
  () => parseAdminDbProjectRow({ ...validProjectRow, raw_count: -1n }),
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

const validOAuthConnectionRow = {
  account_email: 'user@example.test',
  account_login: 'example-user',
  expires_at: new Date('2026-12-31T00:00:00.000Z'),
  metadata: { driveEnabled: true },
  provider: 'google',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  updated_at: '2026-06-16T00:00:00.000Z',
};

assert.deepEqual(parseAdminDbOAuthConnectionRow(validOAuthConnectionRow), validOAuthConnectionRow);
assert.deepEqual(
  parseAdminDbOAuthConnectionRow({
    ...validOAuthConnectionRow,
    account_email: null,
    account_login: null,
    expires_at: null,
    provider: 'github',
    scopes: null,
    updated_at: null,
  }),
  {
    ...validOAuthConnectionRow,
    account_email: null,
    account_login: null,
    expires_at: null,
    provider: 'github',
    scopes: null,
    updated_at: null,
  },
);
assert.throws(
  () => parseAdminDbOAuthConnectionRow({ ...validOAuthConnectionRow, provider: 'slack' }),
  /Invalid oauth connection row field: provider/,
);
assert.throws(
  () => parseAdminDbOAuthConnectionRow({ ...validOAuthConnectionRow, scopes: 'gmail.readonly' }),
  /Invalid oauth connection row field: scopes/,
);
assert.throws(
  () => parseAdminDbOAuthConnectionRow({ ...validOAuthConnectionRow, scopes: ['read', 123] }),
  /Invalid oauth connection row field: scopes/,
);
assert.throws(() => {
  const { scopes: _scopes, ...rowWithoutScopes } = validOAuthConnectionRow;
  parseAdminDbOAuthConnectionRow(rowWithoutScopes);
}, /Invalid oauth connection row field: scopes/);
assert.throws(
  () => parseAdminDbOAuthConnectionRow({ ...validOAuthConnectionRow, expires_at: 123 }),
  /Invalid oauth connection row field: expires_at/,
);
assert.throws(
  () => parseAdminDbOAuthConnectionRow({ ...validOAuthConnectionRow, account_email: 123 }),
  /Invalid oauth connection row field: account_email/,
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
