import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  buildAgentRawReadView,
  createPostgresRawReadViewRepository,
  createRawReadViewRepository,
  RawReadViewError,
  type RawReadViewLookup,
  type RawReadViewRawDocument,
} from './raw-read-view.ts';

const fixtureRoot = new URL('../../../fixtures/ingestion/', import.meta.url);

class MemoryStorage implements Pick<ObjectStorage, 'getText'> {
  private readonly objects: ReadonlyMap<string, string>;

  constructor(objects: ReadonlyMap<string, string>) {
    this.objects = objects;
  }

  async getText(uri: string): Promise<string> {
    const text = this.objects.get(uri);
    if (text === undefined) {
      throw new Error(`Missing object: ${uri}`);
    }
    return text;
  }
}

class RawReadViewLookupStub implements RawReadViewLookup {
  private readonly records: readonly RawReadViewRawDocument[];

  constructor(records: readonly RawReadViewRawDocument[]) {
    this.records = records;
  }

  async lookupRawReadViewDocument(input: {
    readonly documentId?: string;
    readonly projectId: string;
    readonly rawDocumentId: string;
  }): Promise<RawReadViewRawDocument | undefined> {
    return this.records.find((record) => {
      return (
        record.rawDocumentId === input.rawDocumentId &&
        record.projectId === input.projectId &&
        (!input.documentId || record.documentId === input.documentId)
      );
    });
  }
}

const baseRawDocument = {
  canonicalUri: 'https://example.test/source',
  documentId: 'doc-a',
  projectId: '00000000-0000-4000-8000-000000000001',
  projectSlug: 'project-a',
  rawDocumentId: 'raw-a',
  sourceId: 'source-a',
  storageUri: 'project-a/raw/source-a.json',
  title: 'Source A',
} as const;

const githubText = await fixtureText('github/issue-101.json');
const gmailText = await fixtureText('gmail/thread-alpha.json');
const driveText = await fixtureText('drive/spec-draft.json');
const webText = await fixtureText('web/release-notes.html');

{
  const view = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'github' },
    rawText: githubText,
  });
  assert.equal(view.kind, 'agent_raw_read_view');
  assert.equal(view.trust, 'untrusted_external_content');
  assert.equal(view.data.sections[0]?.untrusted, true);
  assert.equal(view.data.sections[0]?.sourceLocator.kind, 'issue_body');
  assert.match(view.data.sections.map((section) => section.text).join('\n'), /local indexer/);
  assert.doesNotMatch(JSON.stringify(view), /storageUri|parsedUri|raw\/source/);
}

{
  const view = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'gmail' },
    rawText: gmailText,
  });
  assert.equal(view.data.sections.length, 2);
  assert.equal(view.data.sections[0]?.sourceLocator.kind, 'message');
  assert.equal(view.data.sections[1]?.sourceLocator.kind, 'quote');
  assert.doesNotMatch(JSON.stringify(view), /sender@example\.test|reviewer@example\.test/);
  assert.ok(view.data.redactions.some((redaction) => redaction.kind === 'email'));
}

{
  const view = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'drive' },
    rawText: driveText,
  });
  assert.equal(view.data.sections[0]?.sourceLocator.kind, 'heading');
  assert.ok(view.data.sections.some((section) => section.sourceLocator.kind === 'paragraph'));
  assert.doesNotMatch(JSON.stringify(view), /owner@example\.test/);
}

{
  const view = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'web' },
    rawText: webText,
  });
  assert.equal(view.data.sections[0]?.sourceLocator.kind, 'main_text_section');
  assert.match(view.data.sections.map((section) => section.text).join('\n'), /Version 0\.3/);
  assert.doesNotMatch(JSON.stringify(view), /console\.log/);

  const htmlView = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'web' },
    rawText:
      '<html><head><script>console.log("hidden")</script\t\n bar></head><body><h1><span>Title &apos;&#X201D;&#xD800;</span></h1><p>First &#160; paragraph</p><div>Second block</div></body></html>',
  });
  const htmlSectionText = htmlView.data.sections.map((section) => section.text).join('\n');
  assert.match(htmlSectionText, /Title '”/);
  assert.doesNotMatch(htmlSectionText, /span|\uD800/);
  assert.match(htmlSectionText, /First\s+paragraph/);
  assert.match(htmlSectionText, /Second block/);
  assert.doesNotMatch(JSON.stringify(htmlView), /console\.log/);
}

{
  const view = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'github' },
    rawText: JSON.stringify({
      body: 'my_api_key = "abcdef/ghijk+lmnop=" client_secret: abcdef~ghijk contact owner@example.test',
      kind: 'issue',
      title: 'Redaction test',
    }),
  });
  assert.ok(view.data.redactions.some((redaction) => redaction.kind === 'secret'));
  assert.ok(view.data.redactions.some((redaction) => redaction.kind === 'email'));
  assert.match(view.data.sections[0]?.text ?? '', /my_api_key=\[redacted-secret\]/);
  assert.match(view.data.sections[0]?.text ?? '', /client_secret=\[redacted-secret\]/);
  assert.doesNotMatch(JSON.stringify(view), /abcdef\/ghijk|owner@example\.test/);
}

{
  const view = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'github' },
    rawText: JSON.stringify({
      body: 'one two three four five',
      comments: [{ body: 'secret_token=abcdef123456 contact owner@example.test' }],
      kind: 'issue',
      title: 'Limit test',
    }),
    request: { maxChars: 8, maxSections: 1 },
  });
  assert.equal(view.data.limits.truncated, true);
  assert.equal(view.data.limits.nextCursor, 'section:1');
  assert.equal(view.data.sections.length, 1);

  const selected = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'github' },
    rawText: JSON.stringify({
      body: 'body text',
      comments: [{ body: 'comment text' }],
      kind: 'issue',
      title: 'Selector test',
    }),
    request: { sectionSelector: ['comment_1'] },
  });
  assert.deepEqual(
    selected.data.sections.map((section) => section.id),
    ['comment_1'],
  );

  const around = buildAgentRawReadView({
    rawDocument: { ...baseRawDocument, sourceType: 'github' },
    rawText: JSON.stringify({
      body: 'body text',
      comments: [{ body: 'first' }, { body: 'second' }, { body: 'third' }],
      kind: 'issue',
      title: 'Around test',
    }),
    request: { aroundSectionId: 'comment_2', maxSections: 1 },
  });
  assert.deepEqual(
    around.data.sections.map((section) => section.id),
    ['comment_1'],
  );
  assert.equal(around.data.limits.nextCursor, 'section:2');
}

{
  const repository = createRawReadViewRepository({
    lookup: new RawReadViewLookupStub([
      { ...baseRawDocument, projectSlug: 'project-a', sourceType: 'github' },
    ]),
    storage: new MemoryStorage(new Map([[baseRawDocument.storageUri, githubText]])),
  });
  const allowed = await repository.fetchRawReadView({
    projectId: baseRawDocument.projectId,
    rawDocumentId: 'raw-a',
  });
  assert.equal(allowed?.data.rawDocumentId, 'raw-a');
  const denied = await repository.fetchRawReadView({
    projectId: '00000000-0000-4000-8000-000000000002',
    rawDocumentId: 'raw-a',
  });
  assert.equal(denied, undefined);
}

{
  let queried = false;
  const repository = createPostgresRawReadViewRepository({
    sql: (async () => {
      queried = true;
      return [];
    }) as never,
    storage: new MemoryStorage(new Map()),
  });
  const denied = await repository.fetchRawReadView({
    projectId: 'not-a-uuid',
    rawDocumentId: 'also-not-a-uuid',
  });
  assert.equal(denied, undefined);
  assert.equal(queried, false);
}

assert.throws(
  () =>
    buildAgentRawReadView({
      rawDocument: { ...baseRawDocument, sourceType: 'github' },
      rawText: '{not json',
    }),
  (error) => error instanceof RawReadViewError && !/not json/.test(error.message),
);

console.log('web raw read view tests passed');

async function fixtureText(path: string): Promise<string> {
  return readFile(new URL(path, fixtureRoot), 'utf8');
}
