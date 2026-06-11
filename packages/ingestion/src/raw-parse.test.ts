import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  validateParserContract,
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

test('parseRawDocuments caches parser artifact reads within a batch', async () => {
  const storage = new InMemoryParseStorage();
  const firstRawDocument = rawGithubDocument({ id: 'raw-1', sourceId: 'github-issue-101' });
  const secondRawDocument = rawGithubDocument({ id: 'raw-2', sourceId: 'github-issue-102' });
  storage.objects.set(firstRawDocument.storageUri, githubRawText({ number: 101 }));
  storage.objects.set(secondRawDocument.storageUri, githubRawText({ number: 102 }));
  const artifactUri = 'sample-a/parsers/github-parser.json';
  const artifactBody = JSON.stringify({ parser: 'github', version: 1 });
  storage.objects.set(artifactUri, artifactBody);

  const repository = new InMemoryRawParseRepository([
    target(firstRawDocument, 'queue-1'),
    target(secondRawDocument, 'queue-2'),
  ]);
  assert.ok(repository.parserVersion);
  repository.parserVersion = {
    ...repository.parserVersion,
    artifactHash: sha256Hex(artifactBody),
    artifactUri,
  };

  const result = await parseRawDocuments({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
    storage,
  });

  assert.deepEqual(
    result.decisions.map((decision) => decision.decision),
    ['parsed', 'parsed'],
  );
  assert.equal(storage.getTextCounts.get(artifactUri), 1);
});

test('validateParserContract only accepts own JSON properties', () => {
  const result = validateParserContract(JSON.stringify({ title: 'Prototype path fixture' }), {
    requiredPaths: ['toString'],
  });

  assert.deepEqual(result, {
    error: 'Raw document is missing required path: toString',
    ok: false,
  });
});

class InMemoryParseStorage implements ParseObjectStorage {
  readonly getTextCounts = new Map<string, number>();
  readonly objects = new Map<string, string>();

  async getText(uri: string): Promise<string> {
    this.getTextCounts.set(uri, (this.getTextCounts.get(uri) ?? 0) + 1);
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

function rawGithubDocument(
  input: Partial<Pick<ParseQueueTarget['rawDocument'], 'id' | 'sourceId'>> = {},
): ParseQueueTarget['rawDocument'] {
  const sourceId = input.sourceId ?? 'github-issue-101';
  return {
    contentHash: 'a'.repeat(64),
    id: input.id ?? 'raw-1',
    metadata: { fetchedAt: '2026-05-08T00:00:00.000Z' },
    mimeType: 'application/json',
    projectId: 'project-1',
    sourceId,
    sourceType: 'github',
    sourceUri: `https://github.com/example-org/pufu-sample/issues/${sourceId.replace(
      'github-issue-',
      '',
    )}`,
    storageUri: `sample-a/raw/github/${sourceId}.json`,
  };
}

function target(
  rawDocument: ParseQueueTarget['rawDocument'],
  queueId = 'queue-1',
): ParseQueueTarget {
  return {
    attempts: 1,
    dataSourceId: 'data-source-1',
    id: queueId,
    projectId: rawDocument.projectId,
    rawDocument,
  };
}

function githubRawText(input: { number: number }): string {
  return JSON.stringify({
    body: `Issue ${input.number} body`,
    comments: [],
    created_at: '2026-05-08T00:00:00.000Z',
    html_url: `https://github.com/example-org/pufu-sample/issues/${input.number}`,
    kind: 'issue',
    number: input.number,
    repository: 'example-org/pufu-sample',
    title: `Fixture issue ${input.number}`,
    updated_at: '2026-05-08T00:00:00.000Z',
    user: { login: 'author', name: 'Author' },
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
