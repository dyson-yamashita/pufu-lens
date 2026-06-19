import assert from 'node:assert/strict';
import {
  parseAdminDbActorAliasRow,
  parseAdminDbActorRow,
  parseAdminDbAppMemberRow,
  parseAdminDbDataSourcePreviewDocumentRow,
  parseAdminDbDataSourcePreviewQueueRow,
  parseAdminDbDataSourcePreviewScopeRow,
  parseAdminDbDataSourcePreviewSummaryRow,
  parseAdminDbDataSourceRow,
  parseAdminDbIdRow,
  parseAdminDbOAuthConnectionRow,
  parseAdminDbParserProfileRow,
  parseAdminDbProjectMemberRow,
  parseAdminDbProjectRow,
  parseAdminDbPublicProjectReportRow,
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

const validActorRow = {
  actor_type: 'person',
  created_at: '2026-06-13T08:00:00.000Z',
  display_name: 'Sample Actor',
  graph_node_id: 'actor:sample',
  id: 'actor-a',
  primary_email: 'actor@example.test',
  primary_login: 'sample-actor',
  updated_at: new Date('2026-06-14T08:00:00.000Z'),
};

assert.deepEqual(parseAdminDbActorRow(validActorRow), validActorRow);
assert.throws(
  () => parseAdminDbActorRow({ ...validActorRow, display_name: null }),
  /Invalid actor row field: display_name/,
);
assert.throws(
  () => parseAdminDbActorRow({ ...validActorRow, primary_email: 123 }),
  /Invalid actor row field: primary_email/,
);
assert.throws(
  () => parseAdminDbActorRow({ ...validActorRow, created_at: null }),
  /Invalid actor row field: created_at/,
);
assert.throws(
  () => parseAdminDbActorRow({ ...validActorRow, updated_at: 123 }),
  /Invalid actor row field: updated_at/,
);

const validActorAliasRow = {
  actor_id: 'actor-a',
  alias_type: 'email',
  alias_value: 'actor@example.test',
  confidence: 1,
  source: 'gmail:sender',
};

assert.deepEqual(parseAdminDbActorAliasRow(validActorAliasRow), validActorAliasRow);
assert.deepEqual(
  parseAdminDbActorAliasRow({ ...validActorAliasRow, confidence: '0.75', source: null }),
  { ...validActorAliasRow, confidence: '0.75', source: null },
);
assert.throws(
  () => parseAdminDbActorAliasRow({ ...validActorAliasRow, confidence: Number.NaN }),
  /Invalid actor alias row field: confidence/,
);
assert.throws(
  () => parseAdminDbActorAliasRow({ ...validActorAliasRow, confidence: Number.POSITIVE_INFINITY }),
  /Invalid actor alias row field: confidence/,
);
assert.throws(
  () => parseAdminDbActorAliasRow({ ...validActorAliasRow, confidence: 'not-a-number' }),
  /Invalid actor alias row field: confidence/,
);
assert.throws(
  () => parseAdminDbActorAliasRow({ ...validActorAliasRow, confidence: null }),
  /Invalid actor alias row field: confidence/,
);
assert.throws(
  () => parseAdminDbActorAliasRow({ ...validActorAliasRow, source: 123 }),
  /Invalid actor alias row field: source/,
);

const validDataSourceRow = {
  config: { urls: ['https://example.test'] },
  failed_count: 0,
  held_count: 1n,
  id: 'data-source-a',
  ingested_count: '8',
  last_checked_at: '2026-06-16T00:00:00.000Z',
  last_indexed: new Date('2026-06-17T00:00:00.000Z'),
  name: 'Sample Web Source',
  project_id: 'project-a',
  queue_count: 2,
  raw_count: 10,
  source_type: 'web',
};

assert.deepEqual(parseAdminDbDataSourceRow(validDataSourceRow), validDataSourceRow);
assert.throws(
  () => parseAdminDbDataSourceRow({ ...validDataSourceRow, source_type: 'slack' }),
  /Invalid data source row field: source_type/,
);
assert.throws(
  () => parseAdminDbDataSourceRow({ ...validDataSourceRow, raw_count: -1 }),
  /Invalid data source row field: raw_count/,
);
assert.throws(
  () => parseAdminDbDataSourceRow({ ...validDataSourceRow, last_checked_at: 123 }),
  /Invalid data source row field: last_checked_at/,
);
assert.throws(
  () => parseAdminDbDataSourceRow({ ...validDataSourceRow, name: null }),
  /Invalid data source row field: name/,
);

const validParserProfileRow = {
  active_version: '1.0.0',
  held_queue_count: 0,
  id: 'parser-profile-a',
  name: 'Web Parser',
  project_id: 'project-a',
  review_status: 'draft',
  review_validation_report_uri: null,
  review_version: '1.1.0-draft',
  review_version_id: 'review-version-a',
  source_type: 'web',
};

assert.deepEqual(parseAdminDbParserProfileRow(validParserProfileRow), validParserProfileRow);
assert.throws(
  () => parseAdminDbParserProfileRow({ ...validParserProfileRow, source_type: 'slack' }),
  /Invalid parser profile row field: source_type/,
);
assert.throws(
  () => parseAdminDbParserProfileRow({ ...validParserProfileRow, held_queue_count: -1 }),
  /Invalid parser profile row field: held_queue_count/,
);
assert.throws(
  () => parseAdminDbParserProfileRow({ ...validParserProfileRow, name: null }),
  /Invalid parser profile row field: name/,
);
assert.throws(
  () => parseAdminDbParserProfileRow({ ...validParserProfileRow, active_version: 123 }),
  /Invalid parser profile row field: active_version/,
);

const validPreviewScopeRow = {
  id: 'data-source-a',
  last_checked_at: '2026-06-16T00:00:00.000Z',
  project_id: 'project-a',
};

assert.deepEqual(parseAdminDbDataSourcePreviewScopeRow(validPreviewScopeRow), validPreviewScopeRow);
assert.throws(
  () => parseAdminDbDataSourcePreviewScopeRow({ ...validPreviewScopeRow, project_id: null }),
  /Invalid data source preview scope row field: project_id/,
);
assert.throws(
  () => parseAdminDbDataSourcePreviewScopeRow({ ...validPreviewScopeRow, last_checked_at: 123 }),
  /Invalid data source preview scope row field: last_checked_at/,
);

const validPreviewSummaryRow = {
  failed_count: 0,
  held_count: 1n,
  indexed_count: '8',
  last_checked_at: null,
  last_indexed: new Date('2026-06-17T00:00:00.000Z'),
  queue_count: 2,
  raw_count: 10,
};

assert.deepEqual(
  parseAdminDbDataSourcePreviewSummaryRow(validPreviewSummaryRow),
  validPreviewSummaryRow,
);
assert.throws(
  () => parseAdminDbDataSourcePreviewSummaryRow({ ...validPreviewSummaryRow, raw_count: -1 }),
  /Invalid data source preview summary row field: raw_count/,
);
assert.throws(
  () => parseAdminDbDataSourcePreviewSummaryRow({ ...validPreviewSummaryRow, last_indexed: 123 }),
  /Invalid data source preview summary row field: last_indexed/,
);

const validPreviewDocumentRow = {
  canonical_uri: 'https://example.test/doc',
  doc_type: 'web',
  document_id: 'document-a',
  document_summary: 'Summary text',
  fetched_at: new Date('2026-06-16T00:00:00.000Z'),
  first_chunk_content: null,
  indexed_at: '2026-06-17T00:00:00.000Z',
  ingest_status: 'indexed',
  raw_document_id: 'raw-document-a',
  source_id: 'source-a',
  title: 'Sample Document',
};

assert.deepEqual(
  parseAdminDbDataSourcePreviewDocumentRow(validPreviewDocumentRow),
  validPreviewDocumentRow,
);
assert.throws(
  () => parseAdminDbDataSourcePreviewDocumentRow({ ...validPreviewDocumentRow, fetched_at: null }),
  /Invalid data source preview document row field: fetched_at/,
);
assert.throws(
  () =>
    parseAdminDbDataSourcePreviewDocumentRow({ ...validPreviewDocumentRow, ingest_status: null }),
  /Invalid data source preview document row field: ingest_status/,
);

const validPreviewQueueRow = {
  attempts: 2,
  id: 'queue-a',
  last_error: null,
  status: 'held',
  updated_at: '2026-06-16T00:00:00.000Z',
};

assert.deepEqual(parseAdminDbDataSourcePreviewQueueRow(validPreviewQueueRow), validPreviewQueueRow);
assert.throws(
  () => parseAdminDbDataSourcePreviewQueueRow({ ...validPreviewQueueRow, attempts: -1 }),
  /Invalid data source preview queue row field: attempts/,
);
assert.throws(
  () => parseAdminDbDataSourcePreviewQueueRow({ ...validPreviewQueueRow, updated_at: 123 }),
  /Invalid data source preview queue row field: updated_at/,
);

assert.equal(parseAdminDbIdRow({ id: 'user-a' }, 'sample'), 'user-a');
assert.throws(() => parseAdminDbIdRow(null, 'sample'), /Invalid sample row/);
assert.throws(() => parseAdminDbIdRow([], 'sample'), /Invalid sample row/);
assert.throws(() => parseAdminDbIdRow({ id: 123 }, 'sample'), /Invalid sample row field: id/);
assert.throws(() => parseAdminDbIdRow({}, 'sample'), /Invalid sample row field: id/);

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

console.log('web admin db tests passed');
