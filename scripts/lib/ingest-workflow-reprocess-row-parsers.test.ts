import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReprocessCandidateRow,
  parseReprocessResetSummaryRow,
  parseStaleParserCountRow,
} from './ingest-workflow-reprocess-row-parsers.ts';

test('parseStaleParserCountRow accepts integer counts', () => {
  assert.deepEqual(parseStaleParserCountRow({ count: 3 }), { count: 3 });
  assert.deepEqual(parseStaleParserCountRow({ count: '5' }), { count: 5 });
});

test('parseReprocessCandidateRow validates queue-bound candidate rows', () => {
  assert.deepEqual(
    parseReprocessCandidateRow({
      queueId: 'queue-1',
      rawDocumentId: 'raw-1',
      sourceId: 'github-issue-101',
    }),
    {
      queueId: 'queue-1',
      rawDocumentId: 'raw-1',
      sourceId: 'github-issue-101',
    },
  );
});

test('parseReprocessResetSummaryRow parses json_agg selected payloads', () => {
  assert.deepEqual(
    parseReprocessResetSummaryRow({
      queueItems: 1,
      rawDocuments: 1,
      selected: [
        {
          queueId: 'queue-1',
          rawDocumentId: 'raw-1',
          sourceId: 'github-issue-101',
        },
      ],
    }),
    {
      queueItems: 1,
      rawDocuments: 1,
      selected: [
        {
          queueId: 'queue-1',
          rawDocumentId: 'raw-1',
          sourceId: 'github-issue-101',
        },
      ],
    },
  );

  assert.deepEqual(
    parseReprocessResetSummaryRow({
      queueItems: 0,
      rawDocuments: 0,
      selected: null,
    }),
    {
      queueItems: 0,
      rawDocuments: 0,
      selected: [],
    },
  );
});
