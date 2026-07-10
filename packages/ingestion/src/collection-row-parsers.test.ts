import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCollectionDataSourceRecordRow,
  parseCollectionRawDocumentRecordRow,
} from './collection-row-parsers.js';

const validDataSourceRow = {
  config: { repositories: ['example-org/repo'] },
  enabled: true,
  id: 'data-source-1',
  ingestWindow: { since: '2026-01-01T00:00:00.000Z' },
  lastSyncSucceededAt: '2026-05-01T12:00:00.000Z',
  projectId: 'project-1',
  sourceType: 'github',
  syncCursor: { issues: { page: 2 } },
};

const validRawDocumentRow = {
  id: 'raw-1',
  ingestStatus: 'fetched',
  logicalSourceId: 'example-org/repo/issues/12',
  sourceId: 'example-org/repo/issues/12:2026-05-01T00:00:00.000Z:abc',
  sourceType: 'github',
  sourceVersion:
    '2026-05-01T00:00:00.000Z:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

test('parseCollectionDataSourceRecordRow accepts sync cursor and nullable last sync timestamp', () => {
  assert.deepEqual(parseCollectionDataSourceRecordRow(validDataSourceRow), {
    ...validDataSourceRow,
    syncCursor: { issues: { page: 2 } },
  });
  assert.deepEqual(
    parseCollectionDataSourceRecordRow({
      ...validDataSourceRow,
      lastSyncSucceededAt: null,
      syncCursor: {},
    }),
    {
      ...validDataSourceRow,
      lastSyncSucceededAt: null,
      syncCursor: {},
    },
  );
});

test('parseCollectionDataSourceRecordRow normalizes Date timestamps', () => {
  const syncedAt = new Date('2026-05-01T12:00:00.000Z');
  const parsed = parseCollectionDataSourceRecordRow({
    ...validDataSourceRow,
    lastSyncSucceededAt: syncedAt,
  });
  assert.equal(parsed.lastSyncSucceededAt, syncedAt.toISOString());
});

test('parseCollectionDataSourceRecordRow normalizes string timestamps to UTC ISO', () => {
  const parsed = parseCollectionDataSourceRecordRow({
    ...validDataSourceRow,
    lastSyncSucceededAt: '2026-05-01T12:00:00+09:00',
  });
  assert.equal(parsed.lastSyncSucceededAt, '2026-05-01T03:00:00.000Z');
});

test('parseCollectionDataSourceRecordRow rejects malformed sync cursor values', () => {
  for (const syncCursor of ['cursor', ['page'], null, undefined] as const) {
    assert.throws(
      () =>
        parseCollectionDataSourceRecordRow({
          ...validDataSourceRow,
          syncCursor,
        }),
      /syncCursor/,
    );
  }

  const { syncCursor: _syncCursor, ...rowWithoutSyncCursor } = validDataSourceRow;
  assert.throws(() => parseCollectionDataSourceRecordRow(rowWithoutSyncCursor), /syncCursor/);
});

test('parseCollectionDataSourceRecordRow rejects invalid last sync timestamps', () => {
  assert.throws(
    () =>
      parseCollectionDataSourceRecordRow({
        ...validDataSourceRow,
        lastSyncSucceededAt: 'not-a-date',
      }),
    /lastSyncSucceededAt/,
  );
});

test('parseCollectionRawDocumentRecordRow rejects empty logical source identity fields', () => {
  assert.throws(
    () =>
      parseCollectionRawDocumentRecordRow({
        ...validRawDocumentRow,
        logicalSourceId: '   ',
      }),
    /logicalSourceId/,
  );
  assert.throws(
    () =>
      parseCollectionRawDocumentRecordRow({
        ...validRawDocumentRow,
        sourceVersion: '',
      }),
    /sourceVersion/,
  );
});

test('parseCollectionRawDocumentRecordRow rejects invalid ingest status values', () => {
  assert.throws(
    () =>
      parseCollectionRawDocumentRecordRow({
        ...validRawDocumentRow,
        ingestStatus: 'archived',
      }),
    /ingestStatus/,
  );
});
