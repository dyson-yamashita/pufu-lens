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
import {
  buildWebUrlRawCandidate,
  collectWebUrlSource,
  fetchWebUrl,
  scanWebUrlDataSource,
  type WebUrlFetchResponse,
} from './web-url-source.js';

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

test('scanWebUrlDataSource reads configured URLs, normalizes fragments, and applies limit', () => {
  const candidates = scanWebUrlDataSource(
    dataSource({
      config: {
        url: 'https://Example.test/a#section',
        urls: ['not-a-url', 'https://example.test/b/', 'https://example.test/b/#other'],
      },
      sourceType: 'web',
    }),
    2,
  );

  assert.deepEqual(candidates, [
    { sourceUri: 'https://example.test/a' },
    { sourceUri: 'https://example.test/b' },
  ]);
});

test('buildWebUrlRawCandidate falls back to final URL for invalid canonical links', async () => {
  const html =
    '<html><head><title>Release</title><link rel="canonical" href="javascript:void(0)"></head><body>Body</body></html>';

  const candidate = await buildWebUrlRawCandidate({
    candidate: { sourceUri: 'https://example.test/release' },
    dataSource: dataSource({ id: 'data-source-web', sourceType: 'web' }),
    fetcher: async (): Promise<WebUrlFetchResponse> => ({
      body: html,
      contentType: 'text/html',
      finalUrl: 'https://example.test/release',
      status: 200,
    }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
  });

  assert.equal(candidate.raw.sourceId, 'https://example.test/release');
  assert.equal(candidate.raw.metadata.canonicalUrl, 'https://example.test/release');
});

test('buildWebUrlRawCandidate uses canonical URL as source id and never stores body in metadata', async () => {
  const html =
    '<html><head><title lang="ja"> Release Notes </title><link rel="canonical" href="/release"></head><body>Body</body></html>';

  const candidate = await buildWebUrlRawCandidate({
    candidate: { sourceUri: 'https://example.test/release?utm=1' },
    dataSource: dataSource({ id: 'data-source-web', sourceType: 'web' }),
    fetcher: async (): Promise<WebUrlFetchResponse> => ({
      body: html,
      contentType: 'text/html; charset=utf-8',
      finalUrl: 'https://example.test/release?utm=1',
      status: 200,
    }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
  });

  assert.equal(candidate.raw.sourceId, 'https://example.test/release');
  assert.equal(candidate.raw.sourceUri, 'https://example.test/release?utm=1');
  assert.equal(candidate.raw.mimeType, 'text/html');
  assert.match(candidate.raw.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(candidate.raw.metadata.title, 'Release Notes');
  assert.equal(candidate.raw.metadata.body, undefined);
});

test('buildWebUrlRawCandidate appends a source id hash to avoid storage URI collisions', async () => {
  const fetcher = async (url: string): Promise<WebUrlFetchResponse> => ({
    body: '<html><head><title>Release</title></head><body>Body</body></html>',
    contentType: 'text/html',
    finalUrl: url,
    status: 200,
  });
  const first = await buildWebUrlRawCandidate({
    candidate: { sourceUri: 'https://example.test/foo/bar' },
    dataSource: dataSource({ id: 'data-source-web', sourceType: 'web' }),
    fetcher,
    projectId: 'project-1',
    projectSlug: 'sample-a',
  });
  const second = await buildWebUrlRawCandidate({
    candidate: { sourceUri: 'https://example.test/foo*bar' },
    dataSource: dataSource({ id: 'data-source-web', sourceType: 'web' }),
    fetcher,
    projectId: 'project-1',
    projectSlug: 'sample-a',
  });

  assert.notEqual(first.raw.storageUri, second.raw.storageUri);
  assert.match(first.raw.storageUri, /-[a-f0-9]{12}\.html$/);
  assert.match(second.raw.storageUri, /-[a-f0-9]{12}\.html$/);
});

test('fetchWebUrl decodes response bytes with the declared charset', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      arrayBuffer: async () => Uint8Array.from([0x82, 0xa0]).buffer,
      headers: { get: () => 'text/html; charset=shift_jis' },
      status: 200,
      url: 'https://example.test/sjis',
    }) as unknown as Response) as typeof fetch;

  try {
    const response = await fetchWebUrl('https://example.test/sjis');

    assert.equal(response.body, 'あ');
    assert.equal(response.contentType, 'text/html; charset=shift_jis');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('collectWebUrlSource supports dry-run and duplicate skip without writing storage', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { urls: ['https://example.test/release'] },
      id: 'data-source-web',
      sourceType: 'web',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const fetcher = async (): Promise<WebUrlFetchResponse> => ({
    body: '<html><head><title>Release</title></head><body>Body</body></html>',
    contentType: 'text/html',
    finalUrl: 'https://example.test/release',
    status: 200,
  });

  const dryRun = await collectWebUrlSource({
    dryRun: true,
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
  });
  const collected = await collectWebUrlSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
  });
  const duplicate = await collectWebUrlSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.equal(dryRun.decisions[0]?.decision, 'would_collect');
  assert.equal(collected.decisions[0]?.decision, 'collected');
  assert.equal(duplicate.decisions[0]?.decision, 'skipped_existing');
  assert.equal(repository.rawDocuments.size, 1);
  assert.equal(repository.queue.size, 1);
  assert.equal(repository.links.size, 1);
  assert.equal(storage.objects.size, 1);
});

test('collectWebUrlSource applies limit across all enabled web data sources', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { urls: ['https://example.test/first'] },
      id: 'data-source-web-1',
      sourceType: 'web',
    }),
    dataSource({
      config: { urls: ['https://example.test/second'] },
      id: 'data-source-web-2',
      sourceType: 'web',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const fetchedUrls: string[] = [];

  const result = await collectWebUrlSource({
    fetcher: async (url): Promise<WebUrlFetchResponse> => {
      fetchedUrls.push(url);
      return {
        body: '<html><head><title>Release</title></head><body>Body</body></html>',
        contentType: 'text/html',
        finalUrl: url,
        status: 200,
      };
    },
    limit: 1,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.deepEqual(fetchedUrls, ['https://example.test/first']);
  assert.equal(result.decisions.length, 1);
  assert.equal(repository.rawDocuments.size, 1);
});

test('collectWebUrlSource continues after a candidate fetch failure', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { urls: ['https://example.test/fail', 'https://example.test/release'] },
      id: 'data-source-web',
      sourceType: 'web',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await collectWebUrlSource({
      fetcher: async (url): Promise<WebUrlFetchResponse> => {
        if (url.endsWith('/fail')) {
          throw new Error('temporary network failure token=secret');
        }
        return {
          body: '<html><head><title>Release</title></head><body>Body</body></html>',
          contentType: 'text/html',
          finalUrl: url,
          status: 200,
        };
      },
      projectSlug: 'sample-a',
      repository,
      storage,
    });

    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]?.decision, 'collected');
    assert.equal(repository.rawDocuments.size, 1);
    assert.equal(storage.objects.size, 1);
    assert.match(String(errors[0]), /Failed to build raw web candidate/);
    assert.doesNotMatch(JSON.stringify(errors), /token=secret/);
  } finally {
    console.error = originalConsoleError;
  }
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
