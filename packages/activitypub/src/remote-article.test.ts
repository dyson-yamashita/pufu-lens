import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITYSTREAMS_PUBLIC_URI,
  assertRemoteArticleDocumentType,
  assertRemoteArticleJsonLdContext,
  createRemoteArticleResolver,
  parseEmbeddedCreateArticle,
} from './remote-article.ts';

const remoteActorUri = 'https://remote.example/users/alice';
const articleId = 'https://remote.example/articles/1?q=source';

function buildArticleDocument(overrides: Record<string, unknown> = {}) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Article',
    id: articleId,
    attributedTo: remoteActorUri,
    to: ACTIVITYSTREAMS_PUBLIC_URI,
    name: 'Remote report title',
    content: '<p>hello</p>',
    url: articleId,
    ...overrides,
  };
}

function buildEmbeddedArticle(overrides: Record<string, unknown> = {}) {
  return buildArticleDocument(overrides);
}

function createHermeticResolver(body: unknown, _finalUrl = articleId) {
  return createRemoteArticleResolver({
    canonicalOrigin: 'https://lens.test',
    fetch: async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }),
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
}

test('assertRemoteArticleDocumentType rejects Note documents before Fedify parsing', () => {
  assert.throws(
    () =>
      assertRemoteArticleDocumentType({
        type: 'Note',
        content: 'hello',
      }),
    /not an Article/i,
  );
});

test('assertRemoteArticleJsonLdContext rejects unknown remote context URLs', () => {
  assert.throws(
    () =>
      assertRemoteArticleJsonLdContext({
        '@context': 'https://evil.example/context.jsonld',
      }),
    /@context URL is not permitted/i,
  );
});

test('assertRemoteArticleJsonLdContext rejects nested @import in inline context', () => {
  assert.throws(
    () =>
      assertRemoteArticleJsonLdContext({
        '@context': [
          'https://www.w3.org/ns/activitystreams',
          {
            '@import': 'https://evil.example/import.jsonld',
          },
        ],
      }),
    /@import is not permitted/i,
  );
});

test('assertRemoteArticleJsonLdContext accepts Mastodon-compatible inline context', () => {
  assert.doesNotThrow(() =>
    assertRemoteArticleJsonLdContext({
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          sensitive: 'as:sensitive',
          toot: 'http://joinmastodon.org/ns#',
          Emoji: 'toot:Emoji',
        },
      ],
    }),
  );
});

test('assertRemoteArticleJsonLdContext rejects nested scoped @context with unknown URL', () => {
  assert.throws(
    () =>
      assertRemoteArticleJsonLdContext({
        '@context': [
          'https://www.w3.org/ns/activitystreams',
          {
            Article: {
              '@context': 'https://evil.example/context.jsonld',
              '@id': 'as:Article',
            },
          },
        ],
      }),
    /@context URL is not permitted/i,
  );
});

test('assertRemoteArticleJsonLdContext rejects unknown URL in nested scoped @context array', () => {
  assert.throws(
    () =>
      assertRemoteArticleJsonLdContext({
        '@context': [
          'https://www.w3.org/ns/activitystreams',
          {
            Article: {
              '@context': ['https://evil.example/context.jsonld'],
              '@id': 'as:Article',
            },
          },
        ],
      }),
    /@context URL is not permitted/i,
  );
});

test('assertRemoteArticleJsonLdContext accepts nested scoped @context with allowed URL or inline object', () => {
  assert.doesNotThrow(() =>
    assertRemoteArticleJsonLdContext({
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          Article: {
            '@context': 'https://www.w3.org/ns/activitystreams',
            '@id': 'as:Article',
          },
          name: {
            '@context': {
              name: 'as:name',
            },
            '@id': 'as:name',
          },
        },
      ],
    }),
  );
});

test('parseEmbeddedCreateArticle rejects unknown @context before document loader', async () => {
  await assert.rejects(
    () =>
      parseEmbeddedCreateArticle({
        createActorUri: remoteActorUri,
        isDomainBlocked: () => false,
        object: buildEmbeddedArticle({
          '@context': 'https://evil.example/context.jsonld',
        }),
      }),
    /@context URL is not permitted/i,
  );
});

test('remote article resolver rejects inline @import before document loader', async () => {
  const resolver = createHermeticResolver(
    buildArticleDocument({
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          '@import': 'https://evil.example/import.jsonld',
        },
      ],
    }),
  );
  await assert.rejects(() => resolver.resolve(articleId), /@import is not permitted/i);
});

test('parseEmbeddedCreateArticle accepts coherent public Article metadata', async () => {
  const article = await parseEmbeddedCreateArticle({
    createActorUri: remoteActorUri,
    isDomainBlocked: () => false,
    object: buildEmbeddedArticle(),
  });
  assert.equal(article.articleId, articleId);
  assert.equal(article.attributedTo, remoteActorUri);
  assert.equal(article.title, 'Remote report title');
  assert.match(article.summaryHtml, /hello/);
  assert.equal(article.originalUrl, articleId);
});

test('parseEmbeddedCreateArticle inherits the enclosing Create ActivityStreams context', async () => {
  const { '@context': _context, ...embedded } = buildEmbeddedArticle();
  const article = await parseEmbeddedCreateArticle({
    createActorUri: remoteActorUri,
    isDomainBlocked: () => false,
    object: embedded,
  });
  assert.equal(article.articleId, articleId);
  assert.equal(article.title, 'Remote report title');
});

test('parseEmbeddedCreateArticle rejects attribution mismatch', async () => {
  await assert.rejects(
    () =>
      parseEmbeddedCreateArticle({
        createActorUri: remoteActorUri,
        isDomainBlocked: () => false,
        object: buildEmbeddedArticle({
          attributedTo: 'https://remote.example/users/bob',
        }),
      }),
    /attributedTo must match Create actor/,
  );
});

test('parseEmbeddedCreateArticle rejects non-public audience', async () => {
  await assert.rejects(
    () =>
      parseEmbeddedCreateArticle({
        createActorUri: remoteActorUri,
        isDomainBlocked: () => false,
        object: buildEmbeddedArticle({
          to: 'https://remote.example/followers/only',
        }),
      }),
    /Public/,
  );
});

test('parseEmbeddedCreateArticle rejects blocked article URLs', async () => {
  const blockedActor = 'https://blocked.example/users/alice';
  await assert.rejects(
    () =>
      parseEmbeddedCreateArticle({
        createActorUri: blockedActor,
        isDomainBlocked: (host) => host === 'blocked.example',
        object: buildEmbeddedArticle({
          id: 'https://blocked.example/articles/1',
          url: 'https://blocked.example/articles/1',
          attributedTo: blockedActor,
        }),
      }),
    /blocked/i,
  );
});

test('parseEmbeddedCreateArticle rejects incoherent origins', async () => {
  await assert.rejects(
    () =>
      parseEmbeddedCreateArticle({
        createActorUri: remoteActorUri,
        isDomainBlocked: () => false,
        object: buildEmbeddedArticle({
          url: 'https://other.example/articles/1',
        }),
      }),
    /origins are not coherent/,
  );
});

test('remote article resolver accepts Announce dereference with different attributedTo', async () => {
  const resolver = createHermeticResolver(
    buildArticleDocument({
      attributedTo: 'https://remote.example/users/editor',
    }),
  );
  const article = await resolver.resolve(articleId);
  assert.equal(article.attributedTo, 'https://remote.example/users/editor');
});

test('remote article resolver rejects Note documents', async () => {
  const resolver = createHermeticResolver({
    type: 'Note',
    content: 'hello',
  });
  await assert.rejects(() => resolver.resolve(articleId), /not an Article/i);
});

test('remote article resolver rejects article id and final URL mismatch', async () => {
  const resolver = createHermeticResolver(
    buildArticleDocument({
      id: 'https://remote.example/articles/other',
    }),
  );
  await assert.rejects(() => resolver.resolve(articleId), /does not match resolved URL/i);
});

test('remote article resolver rejects missing Public audience', async () => {
  const resolver = createHermeticResolver(
    buildArticleDocument({
      to: 'https://remote.example/followers/only',
    }),
  );
  await assert.rejects(() => resolver.resolve(articleId), /Public/i);
});

test('remote article resolver rejects origin incoherence', async () => {
  const resolver = createHermeticResolver(
    buildArticleDocument({
      url: 'https://other.example/articles/1',
    }),
  );
  await assert.rejects(() => resolver.resolve(articleId), /origins are not coherent/i);
});

test('remote article resolver rejects blocked attributedTo and original URL', async () => {
  const blockedActor = 'https://blocked.example/users/alice';
  const blockedArticleId = 'https://blocked.example/articles/1';
  const resolver = createRemoteArticleResolver({
    canonicalOrigin: 'https://lens.test',
    fetch: async () =>
      new Response(
        JSON.stringify(
          buildArticleDocument({
            id: blockedArticleId,
            url: blockedArticleId,
            attributedTo: blockedActor,
          }),
        ),
        { status: 200 },
      ),
    isDomainBlocked: (host) => host === 'blocked.example',
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve(blockedArticleId), /blocked/i);
});

test('parseEmbeddedCreateArticle supplements undefined @context with ActivityStreams', async () => {
  const article = await parseEmbeddedCreateArticle({
    object: buildEmbeddedArticle({ '@context': undefined }),
    createActorUri: remoteActorUri,
    isDomainBlocked: () => false,
  });
  assert.equal(article.title, 'Remote report title');
});

test('parseEmbeddedCreateArticle supplements null @context with ActivityStreams', async () => {
  const article = await parseEmbeddedCreateArticle({
    object: buildEmbeddedArticle({ '@context': null }),
    createActorUri: remoteActorUri,
    isDomainBlocked: () => false,
  });
  assert.equal(article.title, 'Remote report title');
});

test('parseEmbeddedCreateArticle preserves explicit non-null @context for validation', async () => {
  await assert.rejects(
    () =>
      parseEmbeddedCreateArticle({
        object: buildEmbeddedArticle({ '@context': 'https://evil.example/context.jsonld' }),
        createActorUri: remoteActorUri,
        isDomainBlocked: () => false,
      }),
    /@context URL is not permitted/i,
  );
});

test('remote article resolver sanitizes unsafe summary HTML', async () => {
  const resolver = createHermeticResolver(
    buildArticleDocument({
      content: '<p>safe</p><script>alert(1)</script><img src="https://evil.example/x.png" />',
    }),
  );
  const article = await resolver.resolve(articleId);
  assert.match(article.summaryHtml, /safe/);
  assert.doesNotMatch(article.summaryHtml, /script/i);
  assert.doesNotMatch(article.summaryHtml, /img/i);
});
