import assert from 'node:assert/strict';
import {
  parseAdminActionActorRow,
  parseAdminActionDataSourceIngestRow,
  parseAdminActionDataSourceRecordRow,
  parseAdminActionDataSourceRow,
  parseAdminActionDocumentGraphNodeRow,
  parseAdminActionIdRow,
  parseAdminActionParserVersionRow,
  parseAdminActionProjectGraphNameRow,
  parseAdminActionProjectRecordRow,
  parseAdminActionRawDocumentRecordRow,
  parseAdminActionSameHashCandidateRow,
  parseAdminActionStorageObjectUriRow,
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
  parseAdminActionActorRow({
    displayName: 'Sample Actor',
    id: 'actor-a',
    status: 'active',
  }),
  {
    displayName: 'Sample Actor',
    id: 'actor-a',
    status: 'active',
  },
);
assert.throws(
  () => parseAdminActionActorRow({ displayName: 'Sample Actor', id: 'actor-a', status: 'old' }),
  /Invalid admin actor row field: status/,
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

assert.deepEqual(parseAdminActionDocumentGraphNodeRow({ graphNodeId: 'node-a' }), {
  graphNodeId: 'node-a',
});
assert.throws(
  () => parseAdminActionDocumentGraphNodeRow({ graphNodeId: null }),
  /Invalid document graph node row field: graphNodeId/,
);

assert.deepEqual(parseAdminActionProjectGraphNameRow({ graphName: 'graph_sample_a' }), {
  graphName: 'graph_sample_a',
});
assert.deepEqual(parseAdminActionProjectGraphNameRow({ graphName: null }), {
  graphName: null,
});

assert.deepEqual(
  parseAdminActionStorageObjectUriRow({
    parsedUri: null,
    storageUri: 'sample-a/raw/doc.json',
  }),
  {
    parsedUri: null,
    storageUri: 'sample-a/raw/doc.json',
  },
);
assert.deepEqual(
  parseAdminActionStorageObjectUriRow({
    parsedUri: 'sample-a/parsed/doc.json',
    storageUri: 'sample-a/raw/doc.json',
  }),
  {
    parsedUri: 'sample-a/parsed/doc.json',
    storageUri: 'sample-a/raw/doc.json',
  },
);
assert.throws(
  () => parseAdminActionStorageObjectUriRow({ parsedUri: null, storageUri: null }),
  /Invalid storage object uri row field: storageUri/,
);

console.log('web admin actions guards tests passed');
