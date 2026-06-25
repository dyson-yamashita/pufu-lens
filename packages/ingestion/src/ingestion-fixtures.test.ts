import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { IngestionFixtureCase, ParsedDocument } from './ingestion-fixtures.js';
import {
  loadIngestionFixtureCases,
  parseRawContent,
  parseRawFixture,
  validateParsedDocument,
} from './ingestion-fixtures.js';
import type { TopicExtractionAgent } from './topic-extraction-agent.js';

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

test('drive parser emits keyword topics from title and body via topic extraction agent', async () => {
  const topicExtractionAgent: TopicExtractionAgent = {
    async extractTopics(input) {
      return [
        {
          metadata: { source: 'test_title' },
          target: input.title,
          topicType: 'keyword',
        },
        {
          metadata: { source: 'test_body' },
          target: input.bodyText.slice(0, 24),
          topicType: 'keyword',
        },
      ];
    },
  };
  const rawPath = await writeTempRawFixture(
    'drive-topic-keywords.json',
    JSON.stringify({
      bodyText: 'Semantic topics should come from Drive body text.',
      fileId: 'drive-file-topics',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-05-08T10:30:00.000Z',
      owners: [{ email: 'owner@example.test', name: 'Sample Owner' }],
      revisionId: 'rev-topic-1',
      title: 'Drive Topic Fixture',
      webViewLink: 'https://docs.example.test/document/d/drive-file-topics/edit',
    }),
  );

  try {
    const parsed = await parseRawContent(
      buildFixtureCase('drive-topic-keywords', 'drive', rawPath),
      await readFile(join(repoRoot, rawPath), 'utf8'),
      { topicExtractionAgent },
    );

    assert.deepEqual(parsed.relations, []);
    assert.deepEqual(parsed.actors, [
      {
        displayName: 'Sample Owner',
        email: 'owner@example.test',
        role: 'owner',
      },
    ]);
    assert.deepEqual(
      parsed.topics?.map((topic) => ({
        metadata: topic.metadata,
        target: topic.target,
        topicType: topic.topicType,
      })),
      [
        {
          metadata: { source: 'test_title' },
          target: 'Drive Topic Fixture',
          topicType: 'keyword',
        },
        {
          metadata: { source: 'test_body' },
          target: 'Semantic topics should c',
          topicType: 'keyword',
        },
      ],
    );
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

test('web parser extracts JSON-LD author as an actor', async () => {
  const rawPath = await writeTempRawFixture(
    'web-json-ld-author.html',
    `<!doctype html>
<html>
  <head>
    <title>Author web fixture</title>
    <script type="application/ld+json">
      {
        "@context": "http://schema.org",
        "@type": "BlogPosting",
        "author": {
          "@type": "Person",
          "name": "Sample Writer",
          "url": "https://note.example.test/sample-writer/"
        },
        "datePublished": "2019-05-07T10:50:58.000+09:00"
      }
    </script>
  </head>
  <body><article>Author body</article></body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('web-json-ld-author', 'web', rawPath));

    assert.deepEqual(parsed.actors, [
      {
        displayName: 'Sample Writer',
        domain: 'note.example.test/sample-writer',
        role: 'author',
      },
    ]);
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser resolves JSON-LD @graph author references', async () => {
  const rawPath = await writeTempRawFixture(
    'web-json-ld-author-reference.html',
    `<!doctype html>
<html>
  <head>
    <title>Graph author fixture</title>
    <script type="application/ld+json">
      {
        "@context": "http://schema.org",
        "@graph": [
          {
            "@type": "Article",
            "author": { "@id": "#author" }
          },
          {
            "@id": "#author",
            "@type": "Person",
            "name": "Graph Writer",
            "url": "https://note.example.test/graph-writer/"
          }
        ]
      }
    </script>
  </head>
  <body><article>Graph author body</article></body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(
      buildFixtureCase('web-json-ld-author-reference', 'web', rawPath),
    );

    assert.deepEqual(parsed.actors, [
      {
        displayName: 'Graph Writer',
        domain: 'note.example.test/graph-writer',
        role: 'author',
      },
    ]);
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser extracts meta author when JSON-LD author is missing', async () => {
  const rawPath = await writeTempRawFixture(
    'web-meta-author.html',
    `<!doctype html>
<html>
  <head>
    <title>Meta author fixture</title>
    <meta name="author" content="Meta Writer">
  </head>
  <body><article>Meta author body</article></body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('web-meta-author', 'web', rawPath));

    assert.deepEqual(parsed.actors, [{ displayName: 'Meta Writer', role: 'author' }]);
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser resolves relative author links for display-name authors', async () => {
  const rawPath = await writeTempRawFixture(
    'web-relative-author-link.html',
    `<!doctype html>
<html>
  <head>
    <title>Relative author fixture</title>
    <link rel="canonical" href="https://note.example.test/sample-writer/post-1">
    <script type="application/ld+json">
      {
        "@context": "http://schema.org",
        "@type": "BlogPosting",
        "author": {
          "@type": "Person",
          "name": "Sample Writer"
        }
      }
    </script>
  </head>
  <body>
    <a href="/sample-writer" class="a-link">
      Sample Writer
    </a>
    <article>Author link body</article>
  </body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(
      buildFixtureCase('web-relative-author-link', 'web', rawPath),
    );

    assert.deepEqual(parsed.actors, [
      {
        displayName: 'Sample Writer',
        domain: 'note.example.test/sample-writer',
        role: 'author',
      },
    ]);
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser handles valueless attributes and self-closing script tags', async () => {
  const rawPath = await writeTempRawFixture(
    'web-valueless-attributes.html',
    `<!doctype html>
<html>
  <head>
    <title>Valueless Attribute Fixture</title>
    <link disabled rel="canonical" href="https://note.example.test/valueless">
    <script src="bundle.js" />
  </head>
  <body><article>Visible after self-closing script.</article></body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(
      buildFixtureCase('web-valueless-attributes', 'web', rawPath),
    );

    assert.equal(parsed.canonicalUri, 'https://note.example.test/valueless');
    assert.match(parsed.bodyText, /Visible after self-closing script/);
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser keeps escaped angle bracket text while stripping tags', async () => {
  const rawPath = await writeTempRawFixture(
    'web-escaped-angle-brackets.html',
    '<!doctype html><html><head><title>Escaped text</title></head><body>a &lt; b &gt; c <span>tag</span></body></html>',
  );

  try {
    const parsed = await parseRawFixture(
      buildFixtureCase('web-escaped-angle-brackets', 'web', rawPath),
    );

    assert.match(parsed.bodyText, /a < b > c/);
    assert.match(parsed.bodyText, /tag/);
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser reads JSON-LD datePublished without decoding script text entities', async () => {
  const rawPath = await writeTempRawFixture(
    'web-json-ld-entity-text.html',
    `<!doctype html>
<html>
  <head>
    <title>JSON-LD entity text</title>
    <script type="application/ld+json">
      {
        "@type": "BlogPosting",
        "description": "He said &quot;hello&quot;",
        "datePublished": "2019-05-07T10:50:58.000+09:00"
      }
    </script>
  </head>
  <body>body</body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(
      buildFixtureCase('web-json-ld-entity-text', 'web', rawPath),
    );

    assert.equal(parsed.occurredAt, '2019-05-07T01:50:58.000Z');
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser reads JSON-LD datePublished from root arrays', async () => {
  const rawPath = await writeTempRawFixture(
    'web-json-ld-root-array.html',
    `<!doctype html>
<html>
  <head>
    <title>JSON-LD root array</title>
    <script type="application/ld+json">
      [
        {
          "@type": "BreadcrumbList"
        },
        {
          "@type": "BlogPosting",
          "datePublished": "2019-05-07T10:50:58.000+09:00"
        }
      ]
    </script>
  </head>
  <body>body</body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(
      buildFixtureCase('web-json-ld-root-array', 'web', rawPath),
    );

    assert.equal(parsed.occurredAt, '2019-05-07T01:50:58.000Z');
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('web parser generates keyword topics instead of link relations', async () => {
  const rawPath = await writeTempRawFixture(
    'web-topic-keywords.html',
    `<!doctype html>
<html>
  <head>
    <title>Topic Fixture - Author：Series</title>
    <meta name="keywords" content="Pufu, Graph">
  </head>
  <body>
    <article>
      <h1>Topic Fixture</h1>
      <p>This article explains &quot;semantic topics&quot; and 「日本語トピック」.</p>
      <a href="https://example.test/login">Login</a>
      <a href="https://note.example.test/hashtag/%E3%83%97%E8%AD%9C">link tag</a>
    </article>
  </body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('web-topic-keywords', 'web', rawPath));

    assert.deepEqual(parsed.relations, []);
    assert.deepEqual(
      parsed.topics?.map((topic) => ({
        target: topic.target,
        topicType: topic.topicType,
      })),
      [
        { target: 'プ譜', topicType: 'keyword' },
        { target: 'Topic Fixture - Author：Series', topicType: 'keyword' },
        { target: 'Topic Fixture', topicType: 'keyword' },
        { target: 'Author', topicType: 'keyword' },
        { target: 'Series', topicType: 'keyword' },
        { target: 'Pufu', topicType: 'keyword' },
        { target: 'Graph', topicType: 'keyword' },
        { target: 'semantic topics', topicType: 'keyword' },
        { target: '日本語トピック', topicType: 'keyword' },
      ],
    );
  } finally {
    await rm(join(repoRoot, rawPath), { force: true });
  }
});

test('parsed document validation rejects unknown topic types', () => {
  const parsed = {
    actors: [],
    bodyText: 'Body',
    canonicalUri: 'https://example.test/topic',
    docType: 'web_page',
    metadata: {},
    occurredAt: '2026-05-08T00:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'https://example.test/topic',
    sourceType: 'web',
    title: 'Topic validation',
    topics: [{ target: 'Topic', topicType: 'uri' }],
  } as unknown as ParsedDocument;

  assert.throws(
    () => validateParsedDocument(parsed),
    /Parsed document topicType must be 'keyword'/,
  );
});

test('parsed document validation rejects malformed topic entries safely', () => {
  const nullTopicParsed = {
    actors: [],
    bodyText: 'Body',
    canonicalUri: 'https://example.test/topic',
    docType: 'web_page',
    metadata: {},
    occurredAt: '2026-05-08T00:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'https://example.test/topic',
    sourceType: 'web',
    title: 'Topic validation',
    topics: [null],
  } as unknown as ParsedDocument;

  assert.throws(
    () => validateParsedDocument(nullTopicParsed),
    /Parsed document topicType must be 'keyword'/,
  );

  const invalidTargetParsed = {
    ...nullTopicParsed,
    topics: [{ target: 42, topicType: 'keyword' }],
  } as unknown as ParsedDocument;

  assert.throws(
    () => validateParsedDocument(invalidTargetParsed),
    /Parsed document topic target is required/,
  );
});

test('web parser stops topic extraction after the first ten candidates', async () => {
  const rawPath = await writeTempRawFixture(
    'web-topic-limit.html',
    `<!doctype html>
<html>
  <head>
    <title>Topic Cap</title>
    <meta name="keywords" content="one,two,three,four,five,six,seven,eight,nine,ten">
  </head>
  <body>
    <article>
      <p>This late body phrase should not be selected: &quot;late quoted phrase&quot;.</p>
    </article>
  </body>
</html>`,
  );

  try {
    const parsed = await parseRawFixture(buildFixtureCase('web-topic-limit', 'web', rawPath));

    assert.equal(parsed.topics?.length, 10);
    assert.deepEqual(
      parsed.topics?.map((topic) => topic.target),
      ['Topic Cap', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
    );
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
