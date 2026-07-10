import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GraphRecoveryArtifactEvent,
  listRecoveryArtifactEvents,
  type ParsedRecoveryArtifactEvent,
  type RawRecoveryArtifactEvent,
  RECOVERY_ARTIFACT_VERSION,
  type RecoveryArtifactLatestPointer,
  type RecoveryArtifactStorage,
  readRecoveryArtifactEvent,
  readRecoveryArtifactLatestPointer,
  recoveryArtifactEventsSha256,
  recoveryArtifactEventUri,
  recoveryArtifactNaturalKey,
  validateRecoveryArtifactEvent,
  writeRecoveryArtifactEvent,
  writeRecoveryArtifactLatestPointer,
} from './recovery-artifacts.js';

const rawHash = 'a'.repeat(64);
const parsedHash = 'b'.repeat(64);
const graphHash = 'c'.repeat(64);
const parserHash = 'd'.repeat(64);

test('writeRecoveryArtifactEvent stores one raw event object and lists it by prefix', async () => {
  const storage = new MemoryRecoveryArtifactStorage();
  const rawEvent = sampleRawEvent();

  const stored = await writeRecoveryArtifactEvent(storage, rawEvent);

  assert.equal(stored.uri, recoveryArtifactEventUri(rawEvent));
  assert.equal(storage.metadata.get(stored.uri)?.contentType, 'application/json');

  const events = await listRecoveryArtifactEvents(storage, {
    artifactKind: 'raw-document',
    projectSlug: 'sample-a',
  });
  assert.deepEqual(events, [rawEvent]);
});

test('recovery artifact events are sorted by recordedAt after list', async () => {
  const storage = new MemoryRecoveryArtifactStorage();
  const later = sampleParsedEvent({ recordedAt: '2026-06-12T02:00:00.000Z' });
  const earlier = sampleParsedEvent({ recordedAt: '2026-06-12T01:00:00.000Z' });

  await writeRecoveryArtifactEvent(storage, later);
  await writeRecoveryArtifactEvent(storage, earlier);

  const events = await listRecoveryArtifactEvents(storage, {
    artifactKind: 'parsed-document',
    projectSlug: 'sample-a',
  });
  assert.deepEqual(
    events.map((event) => event.recordedAt),
    ['2026-06-12T01:00:00.000Z', '2026-06-12T02:00:00.000Z'],
  );
});

test('listRecoveryArtifactEvents only reads objects under the exact events prefix', async () => {
  const storage = new MemoryRecoveryArtifactStorage();
  await writeRecoveryArtifactEvent(storage, sampleRawEvent());
  storage.objects.set(
    'sample-a/manifests/raw-documents/events-backup/sibling.json',
    `${JSON.stringify(sampleRawEvent({ sourceId: 'https://example.test/sibling' }))}\n`,
  );

  const events = await listRecoveryArtifactEvents(storage, {
    artifactKind: 'raw-document',
    projectSlug: 'sample-a',
  });

  assert.deepEqual(
    events.map((event) => event.sourceId),
    ['https://example.test/a'],
  );
  assert.deepEqual(storage.listPrefixes, ['sample-a/manifests/raw-documents/events/']);
});

test('listRecoveryArtifactEvents reads event objects with bounded concurrency', async () => {
  const storage = new MemoryRecoveryArtifactStorage({ readDelayMs: 5 });
  for (let index = 0; index < 12; index += 1) {
    await writeRecoveryArtifactEvent(
      storage,
      sampleParsedEvent({
        recordedAt: `2026-06-12T01:${String(index).padStart(2, '0')}:00.000Z`,
        sourceId: `https://example.test/${index}`,
      }),
    );
  }

  await listRecoveryArtifactEvents(storage, {
    artifactKind: 'parsed-document',
    projectSlug: 'sample-a',
  });

  assert.equal(storage.maxConcurrentReads, 10);
});

test('graph recovery event validates document snapshot, nodes, edges, and email quotes', () => {
  const event = sampleGraphEvent();

  assert.deepEqual(validateRecoveryArtifactEvent(event), event);
});

test('invalid artifact JSON is reported with the object URI', async () => {
  const storage = new MemoryRecoveryArtifactStorage();
  storage.objects.set('sample-a/manifests/raw-documents/events/broken.json', '{not-json');

  await assert.rejects(
    () => readRecoveryArtifactEvent(storage, 'sample-a/manifests/raw-documents/events/broken.json'),
    /Failed to parse recovery artifact JSON at sample-a\/manifests\/raw-documents\/events\/broken\.json/,
  );
});

test('event prefix mismatch is rejected while listing', async () => {
  const storage = new MemoryRecoveryArtifactStorage();
  await writeRecoveryArtifactEvent(storage, sampleRawEvent({ projectSlug: 'sample-a' }));
  const wrongProjectEvent = sampleRawEvent({
    projectSlug: 'sample-b',
    sourceId: 'https://example.test/b',
  });
  storage.objects.set(
    'sample-a/manifests/raw-documents/events/wrong-project.json',
    `${JSON.stringify(wrongProjectEvent)}\n`,
  );

  await assert.rejects(
    () =>
      listRecoveryArtifactEvents(storage, {
        artifactKind: 'raw-document',
        projectSlug: 'sample-a',
      }),
    /does not match list prefix/,
  );
});

test('latest pointer is written, read, and validated', async () => {
  const storage = new MemoryRecoveryArtifactStorage();
  const events = [sampleRawEvent()];
  const pointer: RecoveryArtifactLatestPointer = {
    artifactKind: 'raw-document' as const,
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    eventCount: events.length,
    generatedAt: '2026-06-12T03:00:00.000Z',
    projectSlug: 'sample-a',
    sha256: recoveryArtifactEventsSha256(events),
  };

  await writeRecoveryArtifactLatestPointer(storage, pointer);

  assert.deepEqual(
    await readRecoveryArtifactLatestPointer(storage, {
      artifactKind: 'raw-document',
      projectSlug: 'sample-a',
    }),
    pointer,
  );
});

test('recovery artifact event hash is stable across toJSON serialization', () => {
  const event = sampleRawEvent({
    metadata: {
      fetchedAtDate: new Date('2026-06-12T00:00:00.000Z'),
    },
  });
  const roundTripped = JSON.parse(JSON.stringify(event));

  assert.equal(recoveryArtifactEventsSha256([event]), recoveryArtifactEventsSha256([roundTripped]));
});

test('recoveryArtifactNaturalKey keeps sourceId and contentHash in v2 identity', () => {
  const event = sampleRawEvent();
  assert.equal(
    recoveryArtifactNaturalKey(event),
    `web:${event.logicalSourceId}:${event.sourceVersion}:${event.sourceId}:${event.contentHash}`,
  );
});

test('optional recovery fields accept null from nullable database columns', () => {
  const event = {
    ...sampleRawEvent(),
    byteSize: null,
    dataSourceKeys: null,
    fetchedAt: null,
    mimeType: null,
    sourceUri: null,
  };

  assert.deepEqual(validateRecoveryArtifactEvent(event), {
    ...sampleRawEvent(),
    byteSize: undefined,
    dataSourceKeys: undefined,
    fetchedAt: undefined,
    mimeType: undefined,
    sourceUri: undefined,
  });
});

test('raw and parsed recovery events do not carry body text fields', () => {
  const rawText = JSON.stringify(sampleRawEvent());
  const parsedText = JSON.stringify(sampleParsedEvent());

  assert.doesNotMatch(rawText, /bodyText|body/);
  assert.doesNotMatch(parsedText, /bodyText|body/);
});

test('schema validation rejects UUID-only parser identity', () => {
  const event = {
    ...sampleParsedEvent(),
    parserProfileKey: undefined,
  };

  assert.throws(() => validateRecoveryArtifactEvent(event), /parserProfileKey/);
});

function sampleRawEvent(
  overrides: Partial<RawRecoveryArtifactEvent> = {},
): RawRecoveryArtifactEvent {
  return {
    artifactKind: 'raw-document',
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    byteSize: 123,
    contentHash: rawHash,
    dataSourceKeys: ['web:https://example.test/feed'],
    fetchedAt: '2026-06-12T00:00:00.000Z',
    logicalSourceId: 'https://example.test/feed',
    metadata: { canonicalUrl: 'https://example.test/a', title: 'Example A' },
    mimeType: 'text/html',
    projectSlug: 'sample-a',
    recordedAt: '2026-06-12T01:00:00.000Z',
    sourceId: 'https://example.test/a',
    sourceType: 'web',
    sourceUri: 'https://example.test/a',
    sourceVersion: rawHash,
    storageUri: 'sample-a/raw/web/a.html',
    ...overrides,
  };
}

function sampleParsedEvent(
  overrides: Partial<ParsedRecoveryArtifactEvent> = {},
): ParsedRecoveryArtifactEvent {
  return {
    artifactKind: 'parsed-document',
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    contentHash: parsedHash,
    logicalSourceId: 'https://example.test/feed',
    parsedAt: '2026-06-12T01:10:00.000Z',
    parsedSchemaVersion: 1,
    parsedUri: 'sample-a/parsed/web/a.json',
    parserArtifactHash: parserHash,
    parserProfileKey: 'web:builtin',
    parserVersion: 'fixture-parser-v1',
    projectSlug: 'sample-a',
    rawStorageUri: 'sample-a/raw/web/a.html',
    recordedAt: '2026-06-12T01:11:00.000Z',
    sourceId: 'https://example.test/a',
    sourceParserProfileId: 'parser-profile-old',
    sourceParserVersionId: 'parser-version-old',
    sourceType: 'web',
    sourceVersion: parsedHash,
    ...overrides,
  };
}

function sampleGraphEvent(
  overrides: Partial<GraphRecoveryArtifactEvent> = {},
): GraphRecoveryArtifactEvent {
  return {
    artifactKind: 'graph-relation',
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    contentHash: graphHash,
    logicalSourceId: 'https://example.test/feed',
    document: {
      canonicalUri: 'https://example.test/a',
      docType: 'web_page',
      metadata: { parser: { parserVersion: 'fixture-parser-v1' } },
      occurredAt: '2026-06-12T00:00:00.000Z',
      summary: 'Example summary',
      title: 'Example A',
    },
    documentGraphNodeId: 'document:web_page:https%3A%2F%2Fexample.test%2Fa',
    edges: [
      {
        fromGraphNodeId: 'document:web_page:https%3A%2F%2Fexample.test%2Fa',
        properties: { relationType: 'TOPIC' },
        toGraphNodeId: 'topic:keyword:example',
        type: 'MENTIONS',
      },
    ],
    emailQuotes: [
      {
        bodyText: 'Quoted context',
        quoteIndex: 1,
        quotedMessageId: 'message-a',
        senderAlias: 'sender@example.test',
        sentAt: '2026-06-12T00:00:00.000Z',
      },
    ],
    nodes: [
      {
        graphNodeId: 'document:web_page:https%3A%2F%2Fexample.test%2Fa',
        labels: ['Document', 'WebPage'],
        properties: { sourceId: 'https://example.test/a' },
      },
      {
        graphNodeId: 'topic:keyword:example',
        labels: ['Topic'],
        properties: { target: 'example', topicType: 'keyword' },
      },
    ],
    projectSlug: 'sample-a',
    recordedAt: '2026-06-12T01:20:00.000Z',
    sourceId: 'https://example.test/a',
    sourceType: 'web',
    sourceVersion: graphHash,
    ...overrides,
  };
}

class MemoryRecoveryArtifactStorage implements RecoveryArtifactStorage {
  activeReads = 0;
  readonly listPrefixes: string[] = [];
  maxConcurrentReads = 0;
  readonly metadata = new Map<
    string,
    { contentType?: string; metadata?: Record<string, string> }
  >();
  readonly objects = new Map<string, string>();

  constructor(private readonly options: { readDelayMs?: number } = {}) {}

  async getText(uri: string): Promise<string> {
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    try {
      if (this.options.readDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.options.readDelayMs));
      }
      const value = this.objects.get(uri);
      if (value === undefined) {
        throw new Error(`Object not found: ${uri}`);
      }
      return value;
    } finally {
      this.activeReads -= 1;
    }
  }

  async *list(prefix: string): AsyncIterable<{ uri: string }> {
    this.listPrefixes.push(prefix);
    for (const uri of [...this.objects.keys()].sort()) {
      if (uri.startsWith(prefix)) {
        yield { uri };
      }
    }
  }

  async put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    opts?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<{ uri: string }> {
    if (typeof body !== 'string') {
      throw new Error('MemoryRecoveryArtifactStorage test helper only accepts string bodies.');
    }
    this.objects.set(uri, body);
    this.metadata.set(uri, opts ?? {});
    return { uri };
  }
}
