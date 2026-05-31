import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type CollectionObjectStorage,
  type CollectionRepository,
  collectFixtureSource,
  type DataSourceRecord,
  type LinkDataSourceInput,
  normalizeSourceId,
  type ProjectRecord,
  type QueueCandidateInput,
  type RawDocumentInput,
  type RawDocumentRecord,
  scanFixtureSource,
  shouldCollectCandidate,
} from './collection-pipeline.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('scanFixtureSource rewrites fixture storage paths for the target project', async () => {
  const candidates = await scanFixtureSource({
    projectId: 'project-1',
    projectSlug: 'sample-a',
    sourceType: 'github',
  });

  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.raw.storageUri.startsWith('sample-a/raw/')));
  assert.ok(candidates.every((candidate) => candidate.raw.projectId === 'project-1'));
});

test('shouldCollectCandidate filters by source type, fixture id, and source id', async () => {
  const [candidate] = await scanFixtureSource({
    projectId: 'project-1',
    projectSlug: 'sample-a',
    sourceType: 'github',
  });
  assert.ok(candidate);

  assert.equal(
    shouldCollectCandidate({
      candidate,
      dataSource: dataSource({ config: { fixtureIds: [candidate.fixture.id] } }),
    }),
    true,
  );
  assert.equal(
    shouldCollectCandidate({
      candidate,
      dataSource: dataSource({ config: { fixtureIds: ['other-fixture'] } }),
    }),
    false,
  );
  assert.equal(
    shouldCollectCandidate({
      candidate,
      dataSource: dataSource({ config: { sourceIds: [candidate.raw.sourceId] } }),
    }),
    true,
  );
});

test('shouldCollectCandidate applies valid ingest window dates and ignores invalid date strings', async () => {
  const [candidate] = await scanFixtureSource({
    projectId: 'project-1',
    projectSlug: 'sample-a',
    sourceType: 'github',
  });
  assert.ok(candidate);

  assert.equal(
    shouldCollectCandidate({
      candidate: {
        ...candidate,
        raw: {
          ...candidate.raw,
          metadata: { ...candidate.raw.metadata, fetchedAt: '2026-01-01T00:00:00.000Z' },
        },
      },
      dataSource: dataSource({ ingestWindow: { since: '2100-01-01T00:00:00.000Z' } }),
    }),
    false,
  );
  assert.equal(
    shouldCollectCandidate({
      candidate,
      dataSource: dataSource({ ingestWindow: { since: 'not-a-date' } }),
    }),
    true,
  );
  assert.equal(
    shouldCollectCandidate({
      candidate: {
        ...candidate,
        raw: { ...candidate.raw, metadata: { ...candidate.raw.metadata, fetchedAt: 'not-a-date' } },
      },
      dataSource: dataSource({ ingestWindow: { since: '2026-01-01T00:00:00.000Z' } }),
    }),
    true,
  );
});

test('normalizeSourceId reports invalid web URLs with source context', () => {
  assert.throws(
    () => normalizeSourceId('web', 'not-a-url'),
    /Invalid web source_id URL: not-a-url/,
  );
});

test('collectFixtureSource stores raw data, links data source, queues once, and skips duplicates', async () => {
  const repository = new InMemoryCollectionRepository();
  const storage = new InMemoryObjectStorage();

  const first = await collectFixtureSource({
    projectSlug: 'sample-a',
    repoRoot,
    repository,
    sourceType: 'github',
    storage,
  });
  const second = await collectFixtureSource({
    projectSlug: 'sample-a',
    repoRoot,
    repository,
    sourceType: 'github',
    storage,
  });

  assert.equal(first.decisions.length, 2);
  assert.ok(first.decisions.every((decision) => decision.decision === 'collected'));
  assert.equal(second.decisions.length, 2);
  assert.ok(second.decisions.every((decision) => decision.decision === 'skipped_existing'));
  assert.equal(repository.rawDocuments.size, 2);
  assert.equal(repository.queue.size, 2);
  assert.equal(repository.links.size, 2);
  assert.equal(storage.objects.size, 2);
  assert.equal(repository.markedDataSources.length, 2);
});

test('collectFixtureSource records same hash candidates without merging raw documents', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.sameHashCandidates = [
    { id: 'raw-existing-web', sourceId: 'https://example.test/a', sourceType: 'web' },
  ];
  const storage = new InMemoryObjectStorage();

  await collectFixtureSource({
    projectSlug: 'sample-a',
    repoRoot,
    repository,
    sourceType: 'github',
    storage,
  });

  const [rawDocument] = [...repository.rawDocuments.values()];
  assert.ok(rawDocument);
  assert.deepEqual(rawDocument.metadata.sameAsCandidateRawDocumentIds, ['raw-existing-web']);
  assert.equal(repository.rawDocuments.size, 2);
});

function dataSource(input: Partial<DataSourceRecord> = {}): DataSourceRecord {
  return {
    config: {},
    enabled: true,
    id: 'data-source-github',
    ingestWindow: {},
    projectId: 'project-1',
    sourceType: 'github',
    ...input,
  };
}

class InMemoryObjectStorage implements CollectionObjectStorage {
  readonly objects = new Map<string, Buffer>();

  async put(uri: string, body: Buffer | NodeJS.ReadableStream | string): Promise<{ uri: string }> {
    if (!Buffer.isBuffer(body) && typeof body !== 'string') {
      throw new Error('Stream bodies are not used in collection pipeline tests.');
    }

    this.objects.set(uri, Buffer.from(body));
    return { uri };
  }
}

class InMemoryCollectionRepository implements CollectionRepository {
  readonly dataSources: DataSourceRecord[] = [dataSource()];
  readonly links = new Map<string, LinkDataSourceInput>();
  readonly markedDataSources: string[] = [];
  readonly project: ProjectRecord = { id: 'project-1', slug: 'sample-a' };
  readonly queue = new Map<string, QueueCandidateInput>();
  readonly rawDocuments = new Map<string, RawDocumentInput & RawDocumentRecord>();
  sameHashCandidates: Array<{
    id: string;
    sourceId: string;
    sourceType: 'github' | 'web' | 'gmail' | 'drive';
  }> = [];

  async lookupProjectBySlug(slug: string): Promise<ProjectRecord | undefined> {
    return slug === this.project.slug ? this.project : undefined;
  }

  async findDataSources(
    projectId: string,
    sourceType?: DataSourceRecord['sourceType'],
  ): Promise<DataSourceRecord[]> {
    return this.dataSources.filter(
      (source) =>
        source.projectId === projectId && (!sourceType || source.sourceType === sourceType),
    );
  }

  async lookupRawDocument(input: {
    projectId: string;
    sourceId: string;
    sourceType: DataSourceRecord['sourceType'];
  }): Promise<RawDocumentRecord | undefined> {
    return this.rawDocuments.get(rawKey(input.projectId, input.sourceType, input.sourceId));
  }

  async findSameHashCandidates(): Promise<
    Array<{ id: string; sourceId: string; sourceType: 'github' | 'web' | 'gmail' | 'drive' }>
  > {
    return this.sameHashCandidates;
  }

  async upsertRawDocument(input: RawDocumentInput): Promise<RawDocumentRecord> {
    const key = rawKey(input.projectId, input.sourceType, input.sourceId);
    const rawDocument = {
      ...input,
      id: this.rawDocuments.get(key)?.id ?? `raw-${this.rawDocuments.size + 1}`,
      ingestStatus: 'fetched' as const,
    };
    this.rawDocuments.set(key, rawDocument);
    return rawDocument;
  }

  async linkDataSource(input: LinkDataSourceInput): Promise<void> {
    this.links.set(`${input.rawDocumentId}:${input.dataSourceId}`, input);
  }

  async queueCandidate(input: QueueCandidateInput): Promise<void> {
    this.queue.set(`${input.projectId}:${input.rawDocumentId}`, input);
  }

  async markDataSourceChecked(dataSourceId: string): Promise<void> {
    this.markedDataSources.push(dataSourceId);
  }
}

function rawKey(projectId: string, sourceType: string, sourceId: string): string {
  return `${projectId}:${sourceType}:${sourceId}`;
}
