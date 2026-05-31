import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultBuiltInParserVersion,
  type HoldReason,
  type MarkFailedInput,
  type MarkHeldInput,
  type MarkParsedInput,
  type ParseObjectStorage,
  type ParseProjectRecord,
  type ParseQueueTarget,
  type ParserVersionRecord,
  parseRawDocuments,
  type RawParseRepository,
} from './raw-parse.js';

test('parseRawDocuments stores parsed JSON and marks raw and queue parsed', async () => {
  const storage = new InMemoryParseStorage();
  const rawDocument = rawGithubDocument();
  storage.objects.set(
    rawDocument.storageUri,
    JSON.stringify({
      body: 'Issue body',
      comments: [{ body: 'Comment body', id: 1, user: { login: 'reviewer', name: 'Reviewer' } }],
      created_at: '2026-05-08T00:00:00.000Z',
      html_url: 'https://github.com/example-org/pufu-sample/issues/101',
      kind: 'issue',
      number: 101,
      repository: 'example-org/pufu-sample',
      title: 'Fixture issue',
      updated_at: '2026-05-08T00:00:00.000Z',
      user: { login: 'author', name: 'Author' },
    }),
  );
  const repository = new InMemoryRawParseRepository([target(rawDocument)]);

  const result = await parseRawDocuments({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.equal(result.decisions[0]?.decision, 'parsed');
  assert.ok(repository.parsed);
  assert.equal(repository.parsed.rawDocumentId, rawDocument.id);
  assert.match(repository.parsed.parsedUri, /sample-a\/parsed\/github\/github-issue-101\.json$/);
  const parsedBody = storage.objects.get(repository.parsed.parsedUri);
  assert.ok(parsedBody);
  const parsed = JSON.parse(parsedBody);
  assert.equal(parsed.title, 'Fixture issue');
  assert.equal(parsed.metadata.parser.parserVersionId, 'parser-version-github');
});

test('parseRawDocuments holds when no approved parser exists', async () => {
  const rawDocument = rawGithubDocument();
  const repository = new InMemoryRawParseRepository([target(rawDocument)]);
  repository.parserVersion = undefined;

  const result = await parseRawDocuments({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
    storage: new InMemoryParseStorage(),
  });

  assert.deepEqual(result.decisions[0], {
    decision: 'held',
    holdReason: 'parser_approval_required',
    queueId: 'queue-1',
    rawDocumentId: 'raw-1',
    sourceId: 'github-issue-101',
    sourceType: 'github',
  });
  assert.equal(repository.held?.holdReason, 'parser_approval_required');
});

test('parseRawDocuments holds contract mismatches before parsing', async () => {
  const storage = new InMemoryParseStorage();
  const rawDocument = rawGithubDocument();
  storage.objects.set(rawDocument.storageUri, JSON.stringify({ title: 'missing required fields' }));
  const repository = new InMemoryRawParseRepository([target(rawDocument)]);

  const result = await parseRawDocuments({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.equal(result.decisions[0]?.decision, 'held');
  assert.equal(repository.held?.holdReason, 'parser_contract_mismatch');
  assert.match(repository.held?.lastError ?? '', /missing required path/);
});

test('parseRawDocuments records parser failures without raw content in errors', async () => {
  const storage = new InMemoryParseStorage();
  const rawDocument = rawGithubDocument();
  storage.objects.set(
    rawDocument.storageUri,
    JSON.stringify({
      body: '',
      created_at: 'not-a-date',
      html_url: 'https://github.com/example-org/pufu-sample/issues/101?token=secret',
      kind: 'issue',
      number: 101,
      repository: 'example-org/pufu-sample',
      title: 'Broken issue',
      user: { login: 'author', name: 'Author' },
    }),
  );
  const repository = new InMemoryRawParseRepository([target(rawDocument)]);

  const result = await parseRawDocuments({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.equal(result.decisions[0]?.decision, 'failed');
  assert.equal(repository.failed?.errorCode, 'parse_failed');
  assert.doesNotMatch(repository.failed?.lastError ?? '', /token=secret/);
});

class InMemoryParseStorage implements ParseObjectStorage {
  readonly objects = new Map<string, string>();

  async getText(uri: string): Promise<string> {
    const value = this.objects.get(uri);
    if (value === undefined) {
      throw new Error(`Object not found: ${uri}`);
    }
    return value;
  }

  async put(uri: string, body: Buffer | NodeJS.ReadableStream | string): Promise<{ uri: string }> {
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
      throw new Error('Stream bodies are not used in raw parse tests.');
    }
    this.objects.set(uri, String(body));
    return { uri };
  }
}

class InMemoryRawParseRepository implements RawParseRepository {
  failed?: MarkFailedInput;
  held?: MarkHeldInput;
  parsed?: MarkParsedInput;
  parserVersion?: ParserVersionRecord;
  readonly project: ParseProjectRecord = { id: 'project-1', slug: 'sample-a' };

  constructor(private readonly targets: ParseQueueTarget[]) {
    this.parserVersion = defaultBuiltInParserVersion({
      parserProfileId: 'parser-profile-github',
      parserVersionId: 'parser-version-github',
      sourceType: 'github',
    });
  }

  async lookupProjectBySlug(slug: string): Promise<ParseProjectRecord | undefined> {
    return slug === this.project.slug ? this.project : undefined;
  }

  async dequeueTargets(input: { limit: number; projectId: string }): Promise<ParseQueueTarget[]> {
    return this.targets
      .filter((queueTarget) => queueTarget.projectId === input.projectId)
      .slice(0, input.limit);
  }

  async selectActiveParserVersion(): Promise<ParserVersionRecord | undefined> {
    return this.parserVersion;
  }

  async markParsed(input: MarkParsedInput): Promise<void> {
    this.parsed = input;
  }

  async markFailed(input: MarkFailedInput): Promise<void> {
    this.failed = input;
  }

  async markHeld(input: MarkHeldInput & { holdReason: HoldReason }): Promise<void> {
    this.held = input;
  }
}

function rawGithubDocument(): ParseQueueTarget['rawDocument'] {
  return {
    contentHash: 'a'.repeat(64),
    id: 'raw-1',
    metadata: { fetchedAt: '2026-05-08T00:00:00.000Z' },
    mimeType: 'application/json',
    projectId: 'project-1',
    sourceId: 'github-issue-101',
    sourceType: 'github',
    sourceUri: 'https://github.com/example-org/pufu-sample/issues/101',
    storageUri: 'sample-a/raw/github/issue-101.json',
  };
}

function target(rawDocument: ParseQueueTarget['rawDocument']): ParseQueueTarget {
  return {
    dataSourceId: 'data-source-1',
    id: 'queue-1',
    projectId: rawDocument.projectId,
    rawDocument,
  };
}
