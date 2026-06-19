import assert from 'node:assert/strict';
import {
  parseAdminActionDataSourceIngestRow,
  parseAdminActionDataSourceRecordRow,
  parseAdminActionDataSourceRow,
  parseAdminActionIdRow,
  parseAdminActionParserVersionRow,
  parseAdminActionProjectRecordRow,
  parseAdminActionRawDocumentRecordRow,
  parseAdminActionSameHashCandidateRow,
} from './admin-actions-guards.ts';

assert.deepEqual(parseAdminActionIdRow({ id: 'row-a' }, 'sample row'), { id: 'row-a' });
assert.throws(() => parseAdminActionIdRow(null, 'sample row'), /Invalid sample row/);
assert.throws(
  () => parseAdminActionIdRow({ id: 123 }, 'sample row'),
  /Invalid sample row field: id/,
);

assert.deepEqual(parseAdminActionProjectRecordRow({ id: 'project-a', slug: 'sample-a' }), {
  id: 'project-a',
  slug: 'sample-a',
});
assert.throws(
  () => parseAdminActionProjectRecordRow({ id: 'project-a', slug: null }),
  /Invalid collection project row field: slug/,
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
  parseAdminActionDataSourceRecordRow({
    config: { repository: 'owner/repo' },
    enabled: true,
    id: 'source-a',
    ingestWindow: {},
    projectId: 'project-a',
    sourceType: 'github',
  }),
  {
    config: { repository: 'owner/repo' },
    enabled: true,
    id: 'source-a',
    ingestWindow: {},
    projectId: 'project-a',
    sourceType: 'github',
  },
);
assert.throws(
  () =>
    parseAdminActionDataSourceRecordRow({
      config: null,
      enabled: true,
      id: 'source-a',
      ingestWindow: {},
      projectId: 'project-a',
      sourceType: 'github',
    }),
  /Invalid collection data source row field: config/,
);
assert.deepEqual(
  parseAdminActionDataSourceRecordRow({
    config: { repository: 'owner/repo' },
    enabled: true,
    id: 'source-a',
    ingestWindow: null,
    projectId: 'project-a',
    sourceType: 'github',
  }),
  {
    config: { repository: 'owner/repo' },
    enabled: true,
    id: 'source-a',
    ingestWindow: {},
    projectId: 'project-a',
    sourceType: 'github',
  },
);
assert.deepEqual(
  parseAdminActionDataSourceRecordRow({
    config: { repository: 'owner/repo' },
    enabled: true,
    id: 'source-b',
    projectId: 'project-a',
    sourceType: 'github',
  }),
  {
    config: { repository: 'owner/repo' },
    enabled: true,
    id: 'source-b',
    ingestWindow: {},
    projectId: 'project-a',
    sourceType: 'github',
  },
);
assert.throws(
  () =>
    parseAdminActionDataSourceRecordRow({
      config: {},
      enabled: 'true',
      id: 'source-a',
      ingestWindow: {},
      projectId: 'project-a',
      sourceType: 'github',
    }),
  /Invalid collection data source row field: enabled/,
);
assert.throws(
  () =>
    parseAdminActionDataSourceRecordRow({
      config: {},
      enabled: true,
      id: 'source-a',
      ingestWindow: {},
      projectId: 'project-a',
      sourceType: 'slack',
    }),
  /Invalid collection data source row field: sourceType/,
);

assert.deepEqual(
  parseAdminActionDataSourceIngestRow({
    id: 'source-a',
    source_type: 'drive',
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

assert.deepEqual(
  parseAdminActionRawDocumentRecordRow({
    id: 'raw-a',
    ingestStatus: 'fetched',
    sourceId: 'issue-1',
    sourceType: 'github',
  }),
  {
    id: 'raw-a',
    ingestStatus: 'fetched',
    sourceId: 'issue-1',
    sourceType: 'github',
  },
);
assert.throws(
  () =>
    parseAdminActionRawDocumentRecordRow({
      id: 'raw-a',
      ingestStatus: 'archived',
      sourceId: 'issue-1',
      sourceType: 'github',
    }),
  /Invalid collection raw document row field: ingestStatus/,
);
assert.throws(
  () =>
    parseAdminActionRawDocumentRecordRow({
      id: 'raw-a',
      ingestStatus: 'fetched',
      sourceId: 123,
      sourceType: 'github',
    }),
  /Invalid collection raw document row field: sourceId/,
);

assert.deepEqual(parseAdminActionParserVersionRow({ id: 'version-a', status: 'draft' }), {
  id: 'version-a',
  status: 'draft',
});
assert.throws(
  () => parseAdminActionParserVersionRow({ id: 'version-a', status: null }),
  /Invalid parser version row field: status/,
);

assert.deepEqual(
  parseAdminActionSameHashCandidateRow({
    id: 'doc-a',
    sourceId: 'source-a',
    sourceType: 'github',
  }),
  { id: 'doc-a', sourceId: 'source-a', sourceType: 'github' },
);
assert.throws(
  () =>
    parseAdminActionSameHashCandidateRow({
      id: 'doc-a',
      sourceId: 'source-a',
      sourceType: 'slack',
    }),
  /Invalid same hash candidate row field: sourceType/,
);
assert.throws(
  () =>
    parseAdminActionSameHashCandidateRow({
      id: 'doc-a',
      sourceId: 123,
      sourceType: 'github',
    }),
  /Invalid same hash candidate row field: sourceId/,
);

console.log('web admin actions guards tests passed');
