import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { IngestionFixtureCase } from './ingestion-fixtures.js';
import {
  loadIngestionFixtureCases,
  parseRawFixture,
  validateParsedDocument,
} from './ingestion-fixtures.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('fixtures declare valid raw document contracts and matching content hashes', async () => {
  const fixtureCases = await loadIngestionFixtureCases();

  assert.ok(fixtureCases.length >= 5);
  for (const fixtureCase of fixtureCases) {
    const rawContent = await readFile(join(repoRoot, fixtureCase.rawPath), 'utf8');
    const actualHash = createHash('sha256').update(rawContent).digest('hex');

    assert.equal(actualHash, fixtureCase.raw.contentHash, fixtureCase.id);
  }
});

test('parse fixtures produce stable parsed JSON snapshots', async () => {
  const fixtureCases = await loadIngestionFixtureCases();

  for (const fixtureCase of fixtureCases) {
    const parsed = validateParsedDocument(await parseRawFixture(fixtureCase));
    const actual = `${JSON.stringify(parsed, null, 2)}\n`;
    const expected = await readFile(join(repoRoot, fixtureCase.snapshotPath), 'utf8');

    assert.equal(actual, expected, fixtureCase.id);
  }
});

test('gmail fixture keeps quoted messages out of primary document body', async () => {
  const fixtureCases = await loadIngestionFixtureCases();
  const gmailCase = fixtureCases.find((fixtureCase) => fixtureCase.id === 'gmail-thread-alpha');

  assert.ok(gmailCase);
  const parsed = await parseRawFixture(gmailCase);

  assert.equal(parsed.docType, 'email');
  assert.equal(parsed.emailQuotes?.length, 1);
  assert.doesNotMatch(parsed.bodyText, /Please keep quoted text/);
});

test('gmail parser accepts empty recipients and missing quoted messages', async () => {
  const rawPath = await writeTempRawFixture(
    'gmail-empty-arrays.json',
    JSON.stringify({
      bodyText: 'Message without visible recipients or quoted history.',
      from: { email: 'sender@example.test', name: 'Sample Sender' },
      messageId: 'msg-empty-001',
      quotedMessages: null,
      sentAt: '2026-05-08T09:00:00.000Z',
      subject: 'Empty recipient fixture',
      threadId: 'thread-empty',
      to: null,
    }),
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('gmail-empty', 'gmail', rawPath));

    assert.equal(parsed.actors.length, 1);
    assert.equal(parsed.emailQuotes?.length, 0);
    assert.equal(parsed.relations.length, 0);
    assert.deepEqual(parsed.metadata, { threadId: 'thread-empty', toCount: 0 });
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('drive parser accepts missing owners', async () => {
  const rawPath = await writeTempRawFixture(
    'drive-no-owners.json',
    JSON.stringify({
      bodyText: 'Drive document without owner metadata.',
      fileId: 'drive-file-no-owner',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-05-08T10:00:00.000Z',
      owners: null,
      revisionId: 'rev-0001',
      title: 'Drive no owner fixture',
      webViewLink: 'https://docs.example.test/document/d/drive-file-no-owner/edit',
    }),
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('drive-no-owners', 'drive', rawPath));

    assert.equal(parsed.actors.length, 0);
    assert.equal(parsed.docType, 'drive_doc');
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser prefers schema.org datePublished over fetchedAt', async () => {
  const rawPath = await writeTempRawFixture(
    'web-date-published.html',
    `<!doctype html>
<html>
  <head>
    <title>Published web fixture</title>
    <link rel="canonical" href="https://note.example.test/published">
    <script type="application/ld+json">
      {
        "@context": "http://schema.org",
        "@graph": [
          {
            "@type": "BlogPosting",
            "datePublished": "2019-05-07T10:50:58.000+09:00"
          }
        ]
      }
    </script>
  </head>
  <body><article>Published body</article></body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('web-date-published', 'web', rawPath));

    assert.equal(parsed.occurredAt, '2019-05-07T01:50:58.000Z');
    assert.equal(parsed.canonicalUri, 'https://note.example.test/published');
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser falls back to fetchedAt when published date is missing', async () => {
  const rawPath = await writeTempRawFixture(
    'web-no-published-date.html',
    '<!doctype html><html><head><title>No published date</title></head><body>body</body></html>',
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('web-no-published-date', 'web', rawPath));

    assert.equal(parsed.occurredAt, '2026-05-08T00:00:00.000Z');
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('parser accepts empty document bodies from real-world sources', async () => {
  const rawPath = await writeTempRawFixture(
    'github-empty-body.json',
    JSON.stringify({
      body: '',
      comments: [],
      created_at: '2026-05-08T11:00:00.000Z',
      html_url: 'https://github.com/example-org/pufu-sample/issues/303',
      kind: 'issue',
      number: 303,
      repository: 'example-org/pufu-sample',
      title: 'Empty body fixture',
      updated_at: '2026-05-08T11:00:00.000Z',
      user: { login: 'sample-author', name: 'Sample Author' },
    }),
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('github-empty-body', 'github', rawPath));

    assert.equal(parsed.bodyText, '');
    assert.equal(parsed.title, 'Empty body fixture');
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

async function writeTempRawFixture(fileName: string, content: string): Promise<string> {
  const relativePath = `tmp/ingestion-fixtures-test/${fileName}`;
  const absolutePath = join(repoRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${content}\n`);
  return relativePath;
}

function buildFixtureCase(
  id: string,
  sourceType: IngestionFixtureCase['sourceType'],
  rawPath: string,
): IngestionFixtureCase {
  return {
    id,
    raw: {
      contentHash: '0'.repeat(64),
      metadata: { fetchedAt: '2026-05-08T00:00:00.000Z' },
      mimeType: 'application/json',
      projectSlug: 'sample-project',
      sourceId: `${sourceType}-test-source`,
      sourceType,
      sourceUri: `${sourceType}://test-source`,
      storageUri: `sample-project/raw/${sourceType}/test-source.json`,
    },
    rawPath,
    snapshotPath: '',
    sourceType,
  };
}
