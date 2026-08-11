import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITYSTREAMS_PUBLIC_URI,
  assertRemoteArticleDocumentType,
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
