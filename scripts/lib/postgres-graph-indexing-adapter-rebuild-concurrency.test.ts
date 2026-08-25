import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import type { ObjectInfo, ObjectStorage } from '../../packages/storage/dist/object-storage.js';
import {
  createPostgresGraphRebuildIndexingRepository,
  GRAPH_REBUILD_PARSED_TEXT_READ_CONCURRENCY,
} from './postgres-graph-indexing-adapter.ts';

const REBUILD_TARGET_ROW_COUNT = 17;

test('rebuild readGraphTargets bounds Object Storage parsed reads to a fixed concurrency cap', async () => {
  const rows = createGraphTargetRows(REBUILD_TARGET_ROW_COUNT);
  const sql = createMockTransactionReturningRows(rows);
  const tracker = createConcurrencyTrackingStorage();
  const repository = createPostgresGraphRebuildIndexingRepository(sql, tracker.storage);

  const targets = await repository.readGraphTargets({
    limit: REBUILD_TARGET_ROW_COUNT,
    projectId: '00000000-0000-0000-0000-000000000001',
  });

  assert.equal(targets.length, REBUILD_TARGET_ROW_COUNT);
  assert.equal(
    targets.map((target) => target.document.id).join(','),
    rows.map((row) => row.documentId).join(','),
  );
  assert.ok(tracker.maxActive > 1);
  assert.ok(tracker.maxActive <= GRAPH_REBUILD_PARSED_TEXT_READ_CONCURRENCY);
});

test('rebuild readGraphTargets rejects target loading when a parsed read fails', async () => {
  const rows = createGraphTargetRows(3);
  const sql = createMockTransactionReturningRows(rows);
  const storage = createFailingStorage(rows[1]?.parsedUri ?? 'parsed-1.json');
  const repository = createPostgresGraphRebuildIndexingRepository(sql, storage);

  await assert.rejects(
    () =>
      repository.readGraphTargets({
        limit: 3,
        projectId: '00000000-0000-0000-0000-000000000001',
      }),
    /Object read failed/,
  );
});

type GraphTargetRowFixture = {
  readonly docType: 'issue';
  readonly documentId: string;
  readonly documentRawDocumentId: string;
  readonly graphNodeId: string;
  readonly ingestStatus: 'parsed';
  readonly parsedUri: string;
  readonly rawContentHash: string;
  readonly rawDocumentId: string;
  readonly sourceId: string;
};

function createGraphTargetRows(count: number): GraphTargetRowFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    docType: 'issue' as const,
    documentId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    documentRawDocumentId: `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    graphNodeId: `document:issue:fixture-${index}`,
    ingestStatus: 'parsed' as const,
    parsedUri: `issue-716-rebuild/parsed/fixture-${index}.json`,
    rawContentHash: `hash-${index}`,
    rawDocumentId: `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    sourceId: `example-org/pufu-sample/issues/${index}`,
  }));
}

function createMockTransactionReturningRows(
  rows: readonly GraphTargetRowFixture[],
): postgres.TransactionSql {
  const transaction = (async (
    strings: TemplateStringsArray,
    ..._values: readonly unknown[]
  ): Promise<readonly unknown[]> => {
    if (strings.join('').includes('FROM public.documents d')) {
      return rows;
    }
    return [];
  }) as postgres.TransactionSql;
  return transaction;
}

function createConcurrencyTrackingStorage(): {
  readonly maxActive: number;
  readonly storage: ObjectStorage;
} {
  let active = 0;
  let maxActive = 0;
  const storage: ObjectStorage = {
    async exists(): Promise<boolean> {
      return false;
    },
    async get(): Promise<NodeJS.ReadableStream> {
      throw new Error('Not implemented.');
    },
    async getText(): Promise<string> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      active -= 1;
      return JSON.stringify({ docType: 'issue', relations: [] });
    },
    async *list(_prefix: string): AsyncIterable<ObjectInfo> {},
    async put(): Promise<{ uri: string }> {
      throw new Error('Not implemented.');
    },
  };
  return {
    get maxActive() {
      return maxActive;
    },
    storage,
  };
}

function createFailingStorage(failingUri: string): ObjectStorage {
  return {
    async exists(): Promise<boolean> {
      return false;
    },
    async get(): Promise<NodeJS.ReadableStream> {
      throw new Error('Not implemented.');
    },
    async getText(uri: string): Promise<string> {
      if (uri === failingUri) {
        throw new Error('Object read failed.');
      }
      return JSON.stringify({ docType: 'issue', relations: [] });
    },
    async *list(_prefix: string): AsyncIterable<ObjectInfo> {},
    async put(): Promise<{ uri: string }> {
      throw new Error('Not implemented.');
    },
  };
}
