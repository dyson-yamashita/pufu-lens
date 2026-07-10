import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type CollectionObjectStorage,
  type CollectionRepository,
  collectFixtureSource,
  type DataSourceRecord,
  incrementalScanSince,
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
  buildDriveRawCandidate,
  collectDriveSource,
  type DriveFetcher,
  fetchDriveJson,
  fetchDriveText,
  scanDriveDataSource,
} from './drive-source.js';
import {
  buildGitHubRawCandidate,
  collectGitHubSource,
  type GitHubFetcher,
  scanGitHubDataSource,
} from './github-source.js';
import {
  buildGmailRawCandidate,
  collectGmailSource,
  fetchGmailJson,
  type GmailFetcher,
  scanGmailDataSource,
} from './gmail-source.js';
import {
  buildWebUrlRawCandidate,
  collectWebUrlSource,
  fetchWebUrl,
  scanWebUrlDataSource,
  type WebUrlFetchResponse,
} from './web-url-source.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('incrementalScanSince applies overlap and respects configured lower bound', () => {
  assert.equal(
    incrementalScanSince(
      dataSource({
        ingestWindow: { since: '2026-05-01T00:00:00.000Z' },
        lastSyncSucceededAt: '2026-05-02T00:00:00.000Z',
      }),
    ),
    '2026-05-01T23:55:00.000Z',
  );
  assert.equal(
    incrementalScanSince(
      dataSource({
        ingestWindow: { since: '2026-05-03T00:00:00.000Z' },
        lastSyncSucceededAt: '2026-05-02T00:00:00.000Z',
      }),
    ),
    '2026-05-03T00:00:00.000Z',
  );
});

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

  assert.equal(
    candidate.raw.sourceId,
    `https://example.test/release#pufu-version=${candidate.raw.sourceVersion}`,
  );
  assert.equal(candidate.raw.metadata.canonicalUrl, 'https://example.test/release');
});

test('buildWebUrlRawCandidate keeps configured logical URL and versioned source id', async () => {
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

  assert.equal(
    candidate.raw.sourceId,
    `https://example.test/release?utm=1#pufu-version=${candidate.raw.sourceVersion}`,
  );
  assert.equal(candidate.raw.logicalSourceId, 'https://example.test/release?utm=1');
  assert.equal(candidate.raw.sourceVersion, candidate.raw.contentHash);
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
  assert.equal(repository.completedDataSourceSyncs.length, 2);
  assert.deepEqual(repository.completedDataSourceSyncs[0]?.syncCursor, {
    mode: 'full-scan-v1',
    sourceType: 'web',
  });
});

test('collectWebUrlSource stores a new raw version when configured URL content changes', async () => {
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
  let body = '<html><body>Version one</body></html>';
  const fetcher = async (): Promise<WebUrlFetchResponse> => ({
    body,
    contentType: 'text/html',
    finalUrl: 'https://cdn.example.test/current',
    status: 200,
  });

  await collectWebUrlSource({ fetcher, projectSlug: 'sample-a', repository, storage });
  body = '<html><body>Version two</body></html>';
  await collectWebUrlSource({ fetcher, projectSlug: 'sample-a', repository, storage });

  const versions = [...repository.rawDocuments.values()];
  assert.equal(versions.length, 2);
  assert.equal(storage.objects.size, 2);
  assert.ok(
    versions.every((version) => version.logicalSourceId === 'https://example.test/release'),
  );
  assert.notEqual(versions[0]?.sourceVersion, versions[1]?.sourceVersion);
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
  assert.equal(repository.completedDataSourceSyncs.length, 1);
  assert.equal(repository.completedDataSourceSyncs[0]?.dataSourceId, 'data-source-web-1');
});

test('collectWebUrlSource does not let an existing version consume the new-version limit', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { urls: ['https://example.test/first', 'https://example.test/second'] },
      id: 'data-source-web',
      sourceType: 'web',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const fetcher = async (url: string): Promise<WebUrlFetchResponse> => ({
    body: `<html><body>${url}</body></html>`,
    contentType: 'text/html',
    finalUrl: url,
    status: 200,
  });

  await collectWebUrlSource({ fetcher, limit: 1, projectSlug: 'sample-a', repository, storage });
  const second = await collectWebUrlSource({
    fetcher,
    limit: 1,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.deepEqual(
    second.decisions.map((decision) => decision.decision),
    ['skipped_existing', 'collected'],
  );
  assert.equal(repository.rawDocuments.size, 2);
});

test('collectWebUrlSource does not requeue a concurrent exact-version insert winner', async () => {
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
  const fetcher = async (): Promise<WebUrlFetchResponse> => ({
    body: '<html><body>same version</body></html>',
    contentType: 'text/html',
    finalUrl: 'https://example.test/release',
    status: 200,
  });
  const storage = new InMemoryObjectStorage();
  await collectWebUrlSource({ fetcher, projectSlug: 'sample-a', repository, storage });
  repository.hiddenVersionLookups = 1;

  const raced = await collectWebUrlSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.equal(raced.decisions[0]?.decision, 'skipped_existing');
  assert.equal(repository.queueCalls, 1);
});

test('collectWebUrlSource restricts collection to the requested data source id', async () => {
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
  const fetchedUrls: string[] = [];

  await collectWebUrlSource({
    dataSourceId: 'data-source-web-2',
    fetcher: async (url): Promise<WebUrlFetchResponse> => {
      fetchedUrls.push(url);
      return { body: 'second', contentType: 'text/plain', finalUrl: url, status: 200 };
    },
    projectSlug: 'sample-a',
    repository,
    storage: new InMemoryObjectStorage(),
  });

  assert.deepEqual(fetchedUrls, ['https://example.test/second']);
  assert.equal(repository.completedDataSourceSyncs[0]?.dataSourceId, 'data-source-web-2');
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

    assert.equal(result.failureCount, 1);
    assert.equal(result.decisions.length, 2);
    assert.equal(result.decisions[0]?.decision, 'failed');
    assert.match(String(result.decisions[0]?.error), /temporary network failure/);
    assert.doesNotMatch(String(result.decisions[0]?.error), /token=secret/);
    assert.equal(result.decisions[1]?.decision, 'collected');
    assert.equal(repository.rawDocuments.size, 1);
    assert.equal(storage.objects.size, 1);
    assert.equal(repository.completedDataSourceSyncs.length, 0);
    assert.match(String(errors[0]), /Failed to build raw web candidate/);
    assert.doesNotMatch(JSON.stringify(errors), /token=secret/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('scanGitHubDataSource reads configured repositories and collects pull requests by default', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: {
        repositories: ['Example-Org/pufu-sample', 'invalid repo'],
      },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return [githubPullRequest({ number: 202 })];
    },
    limit: 5,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.repository, 'Example-Org/pufu-sample');
  assert.equal(candidates[0]?.issue.number, 202);
  assert.equal(
    candidates[0]?.issue.pull_request?.html_url,
    'https://github.com/example-org/pufu-sample/pull/202',
  );
  assert.match(paths[0] ?? '', /\/pulls\?/);
  assert.match(paths[0] ?? '', /state=all/);
});

test('scanGitHubDataSource paginates pull requests in pages of 30 up to 500', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      const page = Number(new URL(`https://example.test${path}`).searchParams.get('page') ?? '1');
      return Array.from({ length: 30 }, (_, index) =>
        githubPullRequest({ number: (page - 1) * 30 + index + 1 }),
      );
    },
  });

  assert.equal(candidates.length, 500);
  assert.equal(paths.length, 17);
  assert.match(paths[0] ?? '', /per_page=30/);
  assert.match(paths[0] ?? '', /page=1/);
  assert.match(paths[16] ?? '', /page=17/);
});

test('scanGitHubDataSource stops pull request pagination after the since cutoff', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      ingestWindow: { since: '2026-05-01T00:00:00.000Z' },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      const page = Number(new URL(`https://example.test${path}`).searchParams.get('page') ?? '1');
      const updatedAt = page === 1 ? '2026-05-09T00:00:00.000Z' : '2026-04-30T00:00:00.000Z';
      return Array.from({ length: 30 }, (_, index) =>
        githubPullRequest({ number: (page - 1) * 30 + index + 1, updatedAt }),
      );
    },
  });

  assert.equal(candidates.length, 30);
  assert.equal(paths.length, 2);
});

test('scanGitHubDataSource stops pull request pagination within a page at the since cutoff', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      ingestWindow: { since: '2026-05-01T00:00:00.000Z' },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return Array.from({ length: 30 }, (_, index) =>
        githubPullRequest({
          number: index + 1,
          updatedAt: index < 20 ? '2026-05-09T00:00:00.000Z' : '2026-04-30T00:00:00.000Z',
        }),
      );
    },
  });

  assert.equal(candidates.length, 20);
  assert.equal(paths.length, 1);
});

test('scanGitHubDataSource passes remaining limits to later repositories', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: {
        repositories: ['example-org/pufu-sample', 'example-org/pufu-other'],
      },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      const page = Number(new URL(`https://example.test${path}`).searchParams.get('page') ?? '1');
      const base = path.includes('/pufu-other/') ? 1000 : 0;
      const length = path.includes('/pufu-other/') ? 30 : 29;
      return Array.from({ length }, (_, index) =>
        githubPullRequest({ number: base + (page - 1) * 30 + index + 1 }),
      );
    },
    limit: 31,
  });

  assert.equal(candidates.length, 31);
  assert.equal(paths.filter((path) => path.includes('/pufu-other/pulls?')).length, 1);
});

test('scanGitHubDataSource accepts string maxPullRequests config values', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { maxPullRequests: '31', repositories: ['example-org/pufu-sample'] },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      const page = Number(new URL(`https://example.test${path}`).searchParams.get('page') ?? '1');
      return Array.from({ length: 30 }, (_, index) =>
        githubPullRequest({ number: (page - 1) * 30 + index + 1 }),
      );
    },
  });

  assert.equal(candidates.length, 31);
  assert.equal(paths.length, 2);
});

test('scanGitHubDataSource collects linked issues referenced by pull request closing keywords', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      if (path.includes('/pulls?')) {
        return [
          githubPullRequest({ body: 'Fixes #101, example-org/pufu-sample#102', number: 202 }),
          githubPullRequest({ body: 'Closes #101', number: 203 }),
        ];
      }
      if (path.endsWith('/issues/101')) {
        return githubIssue({ number: 101 });
      }
      if (path.endsWith('/issues/102')) {
        return githubIssue({ number: 102 });
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => githubCandidateLabel(candidate)),
    ['pull_request:202', 'pull_request:203', 'issue:101', 'issue:102'],
  );
  assert.equal(paths.filter((path) => path.endsWith('/issues/101')).length, 1);
});

test('scanGitHubDataSource keeps scanning linked issue refs until the remaining limit is filled', async () => {
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      if (path.includes('/pulls?')) {
        return [githubPullRequest({ body: 'Fixes #101, #102', number: 202 })];
      }
      if (path.endsWith('/issues/101')) {
        return githubIssue({ number: 101, pullRequest: true });
      }
      if (path.endsWith('/issues/102')) {
        return githubIssue({ number: 102 });
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    },
    limit: 2,
  });

  assert.deepEqual(
    candidates.map((candidate) => githubCandidateLabel(candidate)),
    ['pull_request:202', 'issue:102'],
  );
});

test('scanGitHubDataSource deduplicates linked issue refs across repository casing', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { repositories: ['Example-Org/Pufu-Sample'] },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      if (path.includes('/pulls?')) {
        return [
          githubPullRequest({
            body: 'Fixes Example-Org/Pufu-Sample#101, example-org/pufu-sample#101',
            number: 202,
          }),
        ];
      }
      if (path.endsWith('/issues/101')) {
        return githubIssue({ number: 101 });
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => githubCandidateLabel(candidate)),
    ['pull_request:202', 'issue:101'],
  );
  assert.equal(paths.filter((path) => path.endsWith('/issues/101')).length, 1);
});

test('scanGitHubDataSource continues when a linked issue fetch fails', async () => {
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const candidates = await scanGitHubDataSource({
      dataSource: dataSource({
        config: { repositories: ['example-org/pufu-sample'] },
        sourceType: 'github',
      }),
      fetcher: async ({ path }): Promise<unknown> => {
        if (path.includes('/pulls?')) {
          return [githubPullRequest({ body: 'Fixes #101, #102', number: 202 })];
        }
        if (path.endsWith('/issues/101')) {
          throw new Error('temporary linked issue failure token=secret');
        }
        if (path.endsWith('/issues/102')) {
          return githubIssue({ number: 102 });
        }
        throw new Error(`Unexpected GitHub path: ${path}`);
      },
    });

    assert.deepEqual(
      candidates.map((candidate) => githubCandidateLabel(candidate)),
      ['pull_request:202', 'issue:102'],
    );
    assert.match(JSON.stringify(errors), /Failed to fetch linked GitHub issue/);
    assert.doesNotMatch(JSON.stringify(errors), /token=secret/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('scanGitHubDataSource can collect standalone issues when explicitly configured', async () => {
  const paths: string[] = [];
  const candidates = await scanGitHubDataSource({
    dataSource: dataSource({
      config: { includeIssues: true, repositories: ['example-org/pufu-sample'] },
      sourceType: 'github',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      if (path.includes('/pulls?')) {
        return [];
      }
      if (path.includes('/issues?')) {
        return [githubIssue({ number: 101 })];
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    },
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.issue.number),
    [101],
  );
  assert.match(paths[1] ?? '', /\/issues\?/);
});

test('buildGitHubRawCandidate converts issue comments, PR reviews, and diff metadata', async () => {
  const rawCandidate = await buildGitHubRawCandidate({
    candidate: {
      issue: githubIssue({ number: 202, pullRequest: true }),
      repository: 'example-org/pufu-sample',
    },
    dataSource: dataSource({ id: 'data-source-github', sourceType: 'github' }),
    diffFetcher: async () => 'diff --git a/file b/file\n',
    fetcher: githubDetailFetcher(),
    projectId: 'project-1',
    projectSlug: 'sample-a',
    token: 'secret-token',
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.equal(raw.kind, 'pull_request');
  assert.equal(raw.comments.length, 1);
  assert.equal(raw.reviews.length, 1);
  assert.match(raw.diff.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    rawCandidate.raw.sourceId,
    `${rawCandidate.raw.logicalSourceId}:${rawCandidate.raw.sourceVersion}`,
  );
  assert.equal(rawCandidate.raw.logicalSourceId, 'example-org/pufu-sample/pulls/202');
  assert.equal(
    rawCandidate.raw.sourceVersion,
    `${githubIssue({ number: 202, pullRequest: true }).updated_at}:${rawCandidate.raw.contentHash}`,
  );
  assert.equal(rawCandidate.raw.metadata.hasDiff, true);
  assert.equal(rawCandidate.raw.metadata.body, undefined);
});

test('buildGitHubRawCandidate falls back to ghost for deleted GitHub users', async () => {
  const rawCandidate = await buildGitHubRawCandidate({
    candidate: {
      issue: { ...githubIssue({ number: 101 }), user: null },
      repository: 'example-org/pufu-sample',
    },
    dataSource: dataSource({ id: 'data-source-github', sourceType: 'github' }),
    diffFetcher: async () => 'diff --git a/file b/file\n',
    fetcher: async ({ path }): Promise<unknown> => {
      if (path.endsWith('/issues/101/comments')) {
        return [{ body: 'Comment body', id: 1, user: null }];
      }
      throw new Error(`Unexpected GitHub path: ${path}`);
    },
    projectId: 'project-1',
    projectSlug: 'sample-a',
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.equal(raw.user.login, 'ghost');
  assert.equal(raw.comments[0]?.user.login, 'ghost');
});

test('collectGitHubSource supports dry-run and duplicate skip without storing token metadata', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      id: 'data-source-github',
      sourceType: 'github',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const paths: string[] = [];
  const fetcher = githubDetailFetcher(paths);

  const dryRun = await collectGitHubSource({
    dryRun: true,
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    diffFetcher: async () => 'diff --git a/file b/file\n',
    token: 'secret-token',
  });
  const collected = await collectGitHubSource({
    diffFetcher: async () => 'diff --git a/file b/file\n',
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    token: 'secret-token',
  });
  const duplicate = await collectGitHubSource({
    diffFetcher: async () => 'diff --git a/file b/file\n',
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    token: 'secret-token',
  });

  assert.equal(dryRun.decisions[0]?.decision, 'would_collect');
  assert.equal(collected.decisions[0]?.decision, 'collected');
  assert.equal(duplicate.decisions[0]?.decision, 'skipped_existing');
  assert.equal(repository.rawDocuments.size, 1);
  assert.equal(repository.queue.size, 1);
  assert.equal(repository.links.size, 1);
  assert.equal(storage.objects.size, 1);
  const [rawDocument] = [...repository.rawDocuments.values()];
  assert.ok(rawDocument);
  assert.doesNotMatch(JSON.stringify(rawDocument.metadata), /secret-token/);
  assert.equal(paths.filter((path) => path.endsWith('/issues/202/comments')).length, 3);
  assert.equal(paths.filter((path) => path.endsWith('/pulls/202/reviews')).length, 3);
  assert.equal(repository.completedDataSourceSyncs.length, 2);
});

test('collectGitHubSource does not store incomplete PR raw when diff fetch fails', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      id: 'data-source-github',
      sourceType: 'github',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await collectGitHubSource({
      diffFetcher: async (): Promise<string> => {
        throw new Error('temporary diff failure token=secret');
      },
      fetcher: githubDetailFetcher(),
      projectSlug: 'sample-a',
      repository,
      storage,
    });

    assert.equal(result.failureCount, 1);
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]?.decision, 'failed');
    assert.match(String(result.decisions[0]?.error), /temporary diff failure/);
    assert.doesNotMatch(String(result.decisions[0]?.error), /token=secret/);
    assert.equal(repository.rawDocuments.size, 0);
    assert.equal(repository.queue.size, 0);
    assert.equal(storage.objects.size, 0);
    assert.equal(repository.completedDataSourceSyncs.length, 0);
    assert.match(JSON.stringify(errors), /Failed to fetch GitHub diff/);
    assert.doesNotMatch(JSON.stringify(errors), /token=secret/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('collectGitHubSource continues after a candidate fetch failure with sanitized logs', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { repositories: ['example-org/pufu-sample'] },
      id: 'data-source-github',
      sourceType: 'github',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await collectGitHubSource({
      fetcher: async ({ path }): Promise<unknown> => {
        if (path.includes('/pulls?')) {
          return [githubPullRequest({ number: 101 }), githubPullRequest({ number: 202 })];
        }
        if (path.endsWith('/issues/101/comments')) {
          throw new Error('temporary GitHub failure token=secret');
        }
        if (path.endsWith('/issues/202/comments')) {
          return [{ body: 'Comment body', id: 1, user: { login: 'commenter', name: 'Commenter' } }];
        }
        if (path.endsWith('/pulls/101/reviews') || path.endsWith('/pulls/202/reviews')) {
          return [];
        }
        throw new Error(`Unexpected GitHub path: ${path}`);
      },
      diffFetcher: async () => 'diff --git a/file b/file\n',
      projectSlug: 'sample-a',
      repository,
      storage,
    });

    assert.equal(result.failureCount, 1);
    assert.equal(result.decisions.length, 2);
    assert.equal(result.decisions[0]?.decision, 'failed');
    assert.equal(result.decisions[1]?.decision, 'collected');
    assert.match(String(result.decisions[0]?.error), /temporary GitHub failure/);
    assert.doesNotMatch(String(result.decisions[0]?.error), /token=secret/);
    assert.equal(repository.rawDocuments.size, 1);
    assert.equal(repository.completedDataSourceSyncs.length, 0);
    assert.match(String(errors[0]), /Failed to build raw GitHub candidate/);
    assert.doesNotMatch(JSON.stringify(errors), /token=secret/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('scanGmailDataSource reads configured labels, query, ingest window, and filters messages', async () => {
  const paths: string[] = [];
  const candidates = await scanGmailDataSource({
    dataSource: dataSource({
      config: {
        labelIds: ['Label_1'],
        messageIds: ['msg-2'],
        query: 'from:sender@example.test',
      },
      ingestWindow: { since: '2026-05-01T00:00:00.000Z' },
      sourceType: 'gmail',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return {
        messages: [
          { id: 'msg-1', threadId: 'thread-1' },
          { id: 'msg-2', threadId: 'thread-1' },
        ],
      };
    },
    limit: 1,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.message.id, 'msg-2');
  const params = new URL(`https://example.test${paths[0] ?? ''}`).searchParams;
  assert.equal(params.get('labelIds'), 'Label_1');
  assert.match(params.get('q') ?? '', /from:sender@example.test/);
  assert.match(params.get('q') ?? '', /after:1777593600/);
});

test('scanGmailDataSource keeps maxResults within the Gmail API maximum', async () => {
  const paths: string[] = [];
  await scanGmailDataSource({
    dataSource: dataSource({
      config: { query: 'label:inbox' },
      sourceType: 'gmail',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return { messages: [] };
    },
    limit: 1_000,
  });

  const maxResults = new URL(`https://example.test${paths[0] ?? ''}`).searchParams.get(
    'maxResults',
  );
  assert.equal(maxResults, '100');
});

test('buildGmailRawCandidate converts latest thread message and previous messages as quotes', async () => {
  const rawCandidate = buildGmailRawCandidate({
    dataSource: dataSource({ id: 'data-source-gmail', sourceType: 'gmail' }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
    thread: gmailThread(),
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.equal(raw.threadId, 'thread-alpha');
  assert.equal(raw.messageId, 'msg-alpha-002');
  assert.equal(raw.subject, 'Fixture ingestion review');
  assert.equal(raw.bodyText, 'Latest update');
  assert.equal(raw.quotedMessages.length, 1);
  assert.equal(raw.quotedMessages[0]?.messageId, 'msg-alpha-001');
  assert.deepEqual(raw.to, [
    { email: 'john@example.test', name: 'Doe, John' },
    { email: 'boss@example.test', name: 'John "The, Boss"' },
    { email: 'jane@example.test', name: 'Jane Reviewer' },
  ]);
  assert.equal(rawCandidate.raw.sourceId, 'thread-alpha:msg-alpha-002');
  assert.equal(rawCandidate.raw.logicalSourceId, 'thread-alpha');
  assert.equal(rawCandidate.raw.sourceVersion, 'msg-alpha-002');
  assert.equal(rawCandidate.raw.metadata.quotedMessageCount, 1);
  assert.equal(rawCandidate.raw.metadata.bodyText, undefined);
});

test('buildGmailRawCandidate decodes HTML single quote entities when plain text is absent', async () => {
  const rawCandidate = buildGmailRawCandidate({
    dataSource: dataSource({ id: 'data-source-gmail', sourceType: 'gmail' }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
    thread: {
      id: 'thread-html',
      messages: [
        gmailMessage({
          bodyMimeType: 'text/html',
          bodyText: '<p>HTML mail&#x27;s fallback</p>',
          from: 'HTML Sender <html@example.test>',
          id: 'msg-html-001',
          internalDate: '1777994400000',
          sentAt: 'Tue, 05 May 2026 15:20:00 +0000',
          subject: 'HTML fallback',
        }),
      ],
    },
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.equal(raw.bodyText, "HTML mail's fallback");
});

test('buildGmailRawCandidate preserves content after self-closing script tags', async () => {
  const rawCandidate = buildGmailRawCandidate({
    dataSource: dataSource({ id: 'data-source-gmail', sourceType: 'gmail' }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
    thread: {
      id: 'thread-html-self-closing',
      messages: [
        gmailMessage({
          bodyMimeType: 'text/html',
          bodyText: '<div>Before</div><script src="app.js" /><p>After</p>',
          from: 'HTML Sender <html@example.test>',
          id: 'msg-html-self-closing-001',
          internalDate: '1777994400000',
          sentAt: 'Tue, 05 May 2026 15:20:00 +0000',
          subject: 'HTML self closing',
        }),
      ],
    },
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.equal(raw.bodyText, 'Before After');
});

test('fetchGmailJson builds Gmail API URLs with URL semantics', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return {
      json: async () => ({ messages: [] }),
      ok: true,
    } as Response;
  }) as typeof fetch;

  try {
    await fetchGmailJson({ path: 'gmail/v1/users/me/messages?maxResults=1', token: 'secret' });
    assert.equal(urls[0], 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('collectGmailSource supports dry-run and duplicate skip without storing token metadata', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { labelIds: ['INBOX'], query: 'from:sender@example.test' },
      id: 'data-source-gmail',
      sourceType: 'gmail',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const fetcher = gmailFetcher();

  const dryRun = await collectGmailSource({
    dryRun: true,
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    token: 'secret-token',
  });
  const collected = await collectGmailSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    token: 'secret-token',
  });
  const duplicate = await collectGmailSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    token: 'secret-token',
  });

  assert.equal(dryRun.decisions[0]?.decision, 'would_collect');
  assert.equal(collected.decisions[0]?.decision, 'collected');
  assert.equal(duplicate.decisions[0]?.decision, 'skipped_existing');
  assert.equal(repository.rawDocuments.size, 1);
  assert.equal(repository.queue.size, 1);
  assert.equal(repository.links.size, 1);
  assert.equal(storage.objects.size, 1);
  const [rawDocument] = [...repository.rawDocuments.values()];
  assert.ok(rawDocument);
  assert.doesNotMatch(JSON.stringify(rawDocument.metadata), /secret-token/);
});

test('collectGmailSource continues after a thread fetch failure with sanitized logs', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { labelIds: ['INBOX'] },
      id: 'data-source-gmail',
      sourceType: 'gmail',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await collectGmailSource({
      fetcher: async ({ path }): Promise<unknown> => {
        if (path.includes('/messages?')) {
          return { messages: [{ id: 'msg-alpha-002', threadId: 'thread-alpha' }] };
        }
        throw new Error('temporary Gmail failure token=secret');
      },
      projectSlug: 'sample-a',
      repository,
      storage,
    });

    assert.equal(result.failureCount, 1);
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]?.decision, 'failed');
    assert.equal(result.decisions[0]?.sourceId, 'thread-alpha:msg-alpha-002');
    assert.match(String(result.decisions[0]?.error), /temporary Gmail failure/);
    assert.doesNotMatch(String(result.decisions[0]?.error), /token=secret/);
    assert.equal(repository.rawDocuments.size, 0);
    assert.equal(storage.objects.size, 0);
    assert.match(String(errors[0]), /Failed to fetch Gmail thread/);
    assert.doesNotMatch(JSON.stringify(errors), /token=secret/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('scanDriveDataSource reads configured folders, applies ingest window, and filters files', async () => {
  const paths: string[] = [];
  const candidates = await scanDriveDataSource({
    dataSource: dataSource({
      config: {
        fileIds: ['drive-file-2'],
        folderIds: ['drive-folder-1'],
        folderUrls: ['https://drive.google.com/drive/folders/drive-folder-2'],
      },
      ingestWindow: { since: '2026-05-01T00:00:00.000Z' },
      sourceType: 'drive',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return {
        files: [driveFile({ id: 'drive-file-1' }), driveFile({ id: 'drive-file-2' })],
      };
    },
    limit: 1,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.file.id, 'drive-file-2');
  assert.equal(candidates[0]?.folderId, 'drive-folder-1');
  const query = new URL(`https://example.test${paths[0] ?? ''}`).searchParams.get('q') ?? '';
  assert.match(query, /'drive-folder-1' in parents/);
  assert.match(query, /modifiedTime > '2026-05-01T00:00:00.000Z'/);
});

test('scanDriveDataSource normalizes Drive folder URLs and since dates', async () => {
  const paths: string[] = [];
  const candidates = await scanDriveDataSource({
    dataSource: dataSource({
      config: {
        folderUrls: [
          'https://drive.google.com/open?id=drive-folder-open',
          'https://drive.google.com/drive/folders/drive-folder-path',
        ],
      },
      ingestWindow: { since: '2026-05-01T00:00:00Z' },
      sourceType: 'drive',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return { files: [driveFile({ id: `drive-file-${paths.length}` })] };
    },
    limit: 2,
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.folderId, 'drive-folder-open');
  assert.equal(candidates[1]?.folderId, 'drive-folder-path');
  const firstQuery = new URL(`https://example.test${paths[0] ?? ''}`).searchParams.get('q') ?? '';
  assert.match(firstQuery, /'drive-folder-open' in parents/);
  assert.match(firstQuery, /modifiedTime > '2026-05-01T00:00:00.000Z'/);
});

test('scanDriveDataSource keeps pageSize within the Drive API maximum', async () => {
  const paths: string[] = [];
  await scanDriveDataSource({
    dataSource: dataSource({
      config: { folderIds: ['drive-folder-1'] },
      sourceType: 'drive',
    }),
    fetcher: async ({ path }): Promise<unknown> => {
      paths.push(path);
      return { files: [] };
    },
    limit: 1_000,
  });

  const pageSize = new URL(`https://example.test${paths[0] ?? ''}`).searchParams.get('pageSize');
  assert.equal(pageSize, '100');
});

test('buildDriveRawCandidate converts file metadata and text without storing body metadata', async () => {
  const rawCandidate = await buildDriveRawCandidate({
    candidate: {
      file: driveFile({ id: 'drive-file-1', name: 'Project Brief', revisionId: 'rev-2' }),
      folderId: 'drive-folder-1',
    },
    dataSource: dataSource({ id: 'data-source-drive', sourceType: 'drive' }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
    textFetcher: async () => 'Drive document body',
    token: 'secret-token',
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.equal(raw.fileId, 'drive-file-1');
  assert.equal(raw.revisionId, 'rev-2');
  assert.equal(raw.title, 'Project Brief');
  assert.equal(raw.bodyText, 'Drive document body');
  assert.equal(rawCandidate.raw.sourceId, 'drive-file-1:rev-2');
  assert.equal(rawCandidate.raw.logicalSourceId, 'drive-file-1');
  assert.equal(rawCandidate.raw.sourceVersion, 'rev-2');
  assert.equal(rawCandidate.raw.metadata.folderId, 'drive-folder-1');
  assert.equal(rawCandidate.raw.metadata.bodyText, undefined);
  assert.doesNotMatch(JSON.stringify(rawCandidate.raw.metadata), /secret-token/);
});

test('buildDriveRawCandidate accepts null owners from Drive API responses', async () => {
  const rawCandidate = await buildDriveRawCandidate({
    candidate: {
      file: { ...driveFile({ id: 'drive-file-no-owners' }), owners: undefined },
      folderId: 'drive-folder-1',
    },
    dataSource: dataSource({ id: 'data-source-drive', sourceType: 'drive' }),
    projectId: 'project-1',
    projectSlug: 'sample-a',
    textFetcher: async () => 'Drive document body',
  });

  const raw = JSON.parse(rawCandidate.body);
  assert.deepEqual(raw.owners, []);
});

test('scanDriveDataSource accepts null owners from list responses', async () => {
  const candidates = await scanDriveDataSource({
    dataSource: dataSource({
      config: { folderIds: ['drive-folder-1'] },
      sourceType: 'drive',
    }),
    fetcher: async (): Promise<unknown> => ({
      files: [{ ...driveFile({ id: 'drive-file-no-owners' }), owners: null }],
    }),
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.file.owners, undefined);
});

test('fetchDriveJson builds Google API URLs with URL semantics', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return {
      json: async () => ({ files: [] }),
      ok: true,
    } as Response;
  }) as typeof fetch;

  try {
    await fetchDriveJson({ path: 'drive/v3/files?pageSize=1', token: 'secret-token' });
    assert.equal(urls[0], 'https://www.googleapis.com/drive/v3/files?pageSize=1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchDriveText rejects binary files before reading response text', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called for unsupported binary files');
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchDriveText({ file: driveFile({ id: 'drive-pdf-1', mimeType: 'application/pdf' }) }),
      /Unsupported Drive MIME type/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchDriveText uses source-specific export formats for Google apps', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      text: async () => 'exported body',
    } as Response;
  }) as typeof fetch;

  try {
    await fetchDriveText({
      file: driveFile({
        id: 'drive-doc-1',
        mimeType: 'application/vnd.google-apps.document',
      }),
    });
    await fetchDriveText({
      file: driveFile({
        id: 'drive-sheet-1',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      }),
    });
    await fetchDriveText({
      file: driveFile({
        id: 'drive-slide-1',
        mimeType: 'application/vnd.google-apps.presentation',
      }),
    });

    assert.equal(
      urls[0],
      'https://www.googleapis.com/drive/v3/files/drive-doc-1/export?mimeType=text/plain',
    );
    assert.equal(
      urls[1],
      'https://www.googleapis.com/drive/v3/files/drive-sheet-1/export?mimeType=text/csv',
    );
    assert.equal(
      urls[2],
      'https://www.googleapis.com/drive/v3/files/drive-slide-1/export?mimeType=text/plain',
    );
    assert.equal(urls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchDriveText reads text-like Drive files with a safe URL', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      text: async () => 'plain text body',
    } as Response;
  }) as typeof fetch;

  try {
    const body = await fetchDriveText({
      file: driveFile({ id: 'drive-text-1', mimeType: 'text/plain' }),
      token: 'secret-token',
    });

    assert.equal(body, 'plain text body');
    assert.equal(urls[0], 'https://www.googleapis.com/drive/v3/files/drive-text-1?alt=media');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('collectDriveSource preserves message from non-Error failures while redacting secrets', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { folderIds: ['drive-folder-1'] },
      id: 'data-source-drive',
      sourceType: 'drive',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await collectDriveSource({
      fetcher: driveListFetcher(),
      projectSlug: 'sample-a',
      repository,
      storage,
      textFetcher: async () => {
        throw { message: 'custom Drive error Bearer secret-token' };
      },
    });

    assert.equal(result.failureCount, 1);
    assert.equal(result.decisions[0]?.decision, 'failed');
    assert.match(String(result.decisions[0]?.error), /custom Drive error/);
    assert.doesNotMatch(String(result.decisions[0]?.error), /secret-token/);
    assert.match(JSON.stringify(errors), /custom Drive error/);
    assert.doesNotMatch(JSON.stringify(errors), /secret-token/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('collectDriveSource supports dry-run and duplicate skip without writing storage', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { folderIds: ['drive-folder-1'] },
      id: 'data-source-drive',
      sourceType: 'drive',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const fetcher = driveListFetcher();

  const dryRun = await collectDriveSource({
    dryRun: true,
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    textFetcher: async () => 'Drive document body',
    token: 'secret-token',
  });
  const collected = await collectDriveSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    textFetcher: async () => 'Drive document body',
    token: 'secret-token',
  });
  const duplicate = await collectDriveSource({
    fetcher,
    projectSlug: 'sample-a',
    repository,
    storage,
    textFetcher: async () => 'Drive document body',
    token: 'secret-token',
  });

  assert.equal(dryRun.decisions[0]?.decision, 'would_collect');
  assert.equal(collected.decisions[0]?.decision, 'collected');
  assert.equal(duplicate.decisions[0]?.decision, 'skipped_existing');
  assert.equal(repository.rawDocuments.size, 1);
  assert.equal(repository.queue.size, 1);
  assert.equal(repository.links.size, 1);
  assert.equal(storage.objects.size, 1);
  const [rawDocument] = [...repository.rawDocuments.values()];
  assert.ok(rawDocument);
  assert.doesNotMatch(JSON.stringify(rawDocument.metadata), /secret-token/);
});

test('collectDriveSource continues after a text fetch failure with sanitized logs', async () => {
  const repository = new InMemoryCollectionRepository();
  repository.dataSources.splice(
    0,
    repository.dataSources.length,
    dataSource({
      config: { folderIds: ['drive-folder-1'] },
      id: 'data-source-drive',
      sourceType: 'drive',
    }),
  );
  const storage = new InMemoryObjectStorage();
  const originalConsoleError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await collectDriveSource({
      fetcher: driveListFetcher(),
      projectSlug: 'sample-a',
      repository,
      storage,
      textFetcher: async () => {
        throw new Error('temporary Drive failure token=secret');
      },
    });

    assert.equal(result.failureCount, 1);
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]?.decision, 'failed');
    assert.match(String(result.decisions[0]?.error), /temporary Drive failure/);
    assert.doesNotMatch(String(result.decisions[0]?.error), /token=secret/);
    assert.equal(repository.rawDocuments.size, 0);
    assert.equal(storage.objects.size, 0);
    assert.match(String(errors[0]), /Failed to build raw Drive candidate/);
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
    lastSyncSucceededAt: null,
    projectId: 'project-1',
    sourceType: 'github',
    syncCursor: {},
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
  readonly completedDataSourceSyncs: Array<{
    dataSourceId: string;
    projectId: string;
    syncCursor: Record<string, unknown>;
  }> = [];
  readonly dataSources: DataSourceRecord[] = [dataSource()];
  readonly links = new Map<string, LinkDataSourceInput>();
  readonly markedDataSources: string[] = [];
  readonly project: ProjectRecord = { id: 'project-1', slug: 'sample-a' };
  readonly queue = new Map<string, QueueCandidateInput>();
  queueCalls = 0;
  readonly rawDocuments = new Map<string, RawDocumentInput & RawDocumentRecord>();
  hiddenVersionLookups = 0;
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
    dataSourceId?: string,
  ): Promise<DataSourceRecord[]> {
    return this.dataSources.filter(
      (source) =>
        source.projectId === projectId &&
        (!sourceType || source.sourceType === sourceType) &&
        (!dataSourceId || source.id === dataSourceId),
    );
  }

  async lookupRawDocument(input: {
    projectId: string;
    sourceId: string;
    sourceType: DataSourceRecord['sourceType'];
  }): Promise<RawDocumentRecord | undefined> {
    return this.rawDocuments.get(rawKey(input.projectId, input.sourceType, input.sourceId));
  }

  async lookupRawDocumentVersion(input: {
    logicalSourceId: string;
    projectId: string;
    sourceType: DataSourceRecord['sourceType'];
    sourceVersion: string;
  }): Promise<RawDocumentRecord | undefined> {
    if (this.hiddenVersionLookups > 0) {
      this.hiddenVersionLookups -= 1;
      return undefined;
    }
    return [...this.rawDocuments.values()].find(
      (rawDocument) =>
        rawDocument.projectId === input.projectId &&
        rawDocument.sourceType === input.sourceType &&
        rawDocument.logicalSourceId === input.logicalSourceId &&
        rawDocument.sourceVersion === input.sourceVersion,
    );
  }

  async findSameHashCandidates(): Promise<
    Array<{ id: string; sourceId: string; sourceType: 'github' | 'web' | 'gmail' | 'drive' }>
  > {
    return this.sameHashCandidates;
  }

  async upsertRawDocument(input: RawDocumentInput) {
    const existingVersion = [...this.rawDocuments.values()].find(
      (rawDocument) =>
        rawDocument.projectId === input.projectId &&
        rawDocument.sourceType === input.sourceType &&
        rawDocument.logicalSourceId === input.logicalSourceId &&
        rawDocument.sourceVersion === input.sourceVersion,
    );
    if (existingVersion) {
      return { inserted: false, rawDocument: existingVersion };
    }
    const key = rawKey(input.projectId, input.sourceType, input.sourceId);
    const rawDocument = {
      ...input,
      id: this.rawDocuments.get(key)?.id ?? `raw-${this.rawDocuments.size + 1}`,
      ingestStatus: 'fetched' as const,
    };
    this.rawDocuments.set(key, rawDocument);
    return { inserted: true, rawDocument };
  }

  async linkDataSource(input: LinkDataSourceInput): Promise<void> {
    this.links.set(`${input.rawDocumentId}:${input.dataSourceId}`, input);
  }

  async queueCandidate(input: QueueCandidateInput): Promise<void> {
    this.queueCalls += 1;
    this.queue.set(`${input.projectId}:${input.rawDocumentId}`, input);
  }

  async markDataSourceChecked(dataSourceId: string): Promise<void> {
    this.markedDataSources.push(dataSourceId);
  }

  async completeDataSourceSync(input: {
    dataSourceId: string;
    projectId: string;
    syncCursor: Record<string, unknown>;
  }): Promise<void> {
    this.completedDataSourceSyncs.push(input);
  }
}

function rawKey(projectId: string, sourceType: string, sourceId: string): string {
  return `${projectId}:${sourceType}:${sourceId}`;
}

function githubIssue(input: { number: number; pullRequest?: boolean }): {
  body: string;
  created_at: string;
  html_url: string;
  number: number;
  pull_request?: { html_url: string };
  title: string;
  updated_at: string;
  user: { login: string; name: string } | null;
} {
  const path = input.pullRequest ? 'pull' : 'issues';
  return {
    body: `Body ${input.number}`,
    created_at: '2026-05-08T00:00:00.000Z',
    html_url: `https://github.com/example-org/pufu-sample/${path}/${input.number}`,
    number: input.number,
    ...(input.pullRequest
      ? {
          pull_request: {
            html_url: `https://github.com/example-org/pufu-sample/pull/${input.number}`,
          },
        }
      : {}),
    title: `GitHub item ${input.number}`,
    updated_at: '2026-05-09T00:00:00.000Z',
    user: { login: 'author', name: 'Author' },
  };
}

function githubPullRequest(input: { body?: string; number: number; updatedAt?: string }): {
  body: string;
  created_at: string;
  diff_url: string;
  html_url: string;
  number: number;
  state: 'closed' | 'open';
  title: string;
  updated_at: string;
  user: { login: string; name: string } | null;
} {
  return {
    body: input.body ?? `Body ${input.number}`,
    created_at: '2026-05-08T00:00:00.000Z',
    diff_url: `https://github.com/example-org/pufu-sample/pull/${input.number}.diff`,
    html_url: `https://github.com/example-org/pufu-sample/pull/${input.number}`,
    number: input.number,
    state: 'open',
    title: `GitHub PR ${input.number}`,
    updated_at: input.updatedAt ?? '2026-05-09T00:00:00.000Z',
    user: { login: 'author', name: 'Author' },
  };
}

function githubCandidateLabel(candidate: {
  issue: { number: number; pull_request?: unknown };
}): string {
  return `${candidate.issue.pull_request ? 'pull_request' : 'issue'}:${candidate.issue.number}`;
}

function githubDetailFetcher(paths: string[] = []): GitHubFetcher {
  return async ({ path }): Promise<unknown> => {
    paths.push(path);
    if (path.includes('/pulls?')) {
      return [githubPullRequest({ number: 202 })];
    }
    if (path.endsWith('/issues/202/comments')) {
      return [{ body: 'Comment body', id: 1, user: { login: 'commenter', name: 'Commenter' } }];
    }
    if (path.endsWith('/pulls/202/reviews')) {
      return [{ id: 2, state: 'APPROVED', user: { login: 'reviewer', name: 'Reviewer' } }];
    }
    throw new Error(`Unexpected GitHub path: ${path}`);
  };
}

function driveFile(input: { id: string; mimeType?: string; name?: string; revisionId?: string }): {
  headRevisionId: string;
  id: string;
  mimeType: string;
  modifiedTime: string;
  name: string;
  owners: Array<{ displayName: string; emailAddress: string }>;
  webViewLink: string;
} {
  return {
    headRevisionId: input.revisionId ?? 'rev-1',
    id: input.id,
    mimeType: input.mimeType ?? 'application/vnd.google-apps.document',
    modifiedTime: '2026-05-09T00:00:00.000Z',
    name: input.name ?? 'Drive document',
    owners: [{ displayName: 'Drive Owner', emailAddress: 'owner@example.test' }],
    webViewLink: `https://drive.google.com/document/d/${input.id}/edit`,
  };
}

function driveListFetcher(): DriveFetcher {
  return async (): Promise<unknown> => ({ files: [driveFile({ id: 'drive-file-1' })] });
}

function gmailFetcher(): GmailFetcher {
  return async ({ path }): Promise<unknown> => {
    if (path.includes('/messages?')) {
      return { messages: [{ id: 'msg-alpha-002', threadId: 'thread-alpha' }] };
    }
    if (path.includes('/threads/thread-alpha?')) {
      return gmailThread();
    }
    throw new Error(`Unexpected Gmail path: ${path}`);
  };
}

function gmailThread(): {
  id: string;
  messages: Array<{
    id: string;
    internalDate: string;
    labelIds: string[];
    payload: {
      headers: Array<{ name: string; value: string }>;
      mimeType: string;
      parts: Array<{ body: { data: string }; mimeType: string }>;
    };
    threadId: string;
  }>;
} {
  return {
    id: 'thread-alpha',
    messages: [
      gmailMessage({
        bodyText: 'Please keep quoted text out of the primary document body.',
        from: 'Sample Reviewer <reviewer@example.test>',
        id: 'msg-alpha-001',
        internalDate: '1777989000000',
        sentAt: 'Tue, 05 May 2026 14:50:00 +0000',
        subject: 'Fixture ingestion review',
      }),
      gmailMessage({
        bodyText: 'Latest update',
        from: 'Sample Sender <sender@example.test>',
        id: 'msg-alpha-002',
        internalDate: '1777994400000',
        sentAt: 'Tue, 05 May 2026 15:20:00 +0000',
        subject: 'Fixture ingestion review',
        to: '"Doe, John" <john@example.test>, "John \\"The, Boss\\"" <boss@example.test>, Jane Reviewer <jane@example.test>',
      }),
    ],
  };
}

function gmailMessage(input: {
  bodyMimeType?: string;
  bodyText: string;
  from: string;
  id: string;
  internalDate: string;
  sentAt: string;
  subject: string;
  to?: string;
}): {
  id: string;
  internalDate: string;
  labelIds: string[];
  payload: {
    headers: Array<{ name: string; value: string }>;
    mimeType: string;
    parts: Array<{ body: { data: string }; mimeType: string }>;
  };
  threadId: string;
} {
  return {
    id: input.id,
    internalDate: input.internalDate,
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: input.from },
        { name: 'To', value: input.to ?? 'Sample Sender <sender@example.test>' },
        { name: 'Subject', value: input.subject },
        { name: 'Date', value: input.sentAt },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        {
          body: { data: Buffer.from(input.bodyText, 'utf8').toString('base64url') },
          mimeType: input.bodyMimeType ?? 'text/plain',
        },
      ],
    },
    threadId: 'thread-alpha',
  };
}
