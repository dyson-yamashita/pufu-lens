import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ChunkEmbeddingRepository,
  type ChunkEmbeddingTarget,
  chunkAndEmbed,
  createDeterministicEmbeddingProvider,
  createGeminiEmbeddingProvider,
  type PreparedDocumentChunk,
  prepareDocumentChunks,
  type ReplaceDocumentChunksInput,
  type UpsertDocumentInput,
  validateGeminiEmbeddingConfig,
} from './chunk-embedding.js';
import type { ParsedDocument } from './ingestion-fixtures.js';
import { sha256Hex } from './ingestion-fixtures.js';

test('deterministic embedding provider returns stable fixed-size vectors', async () => {
  const provider = createDeterministicEmbeddingProvider({ dimensions: 8, model: 'test-model' });

  const first = await provider.embedTexts(['same input']);
  const second = await provider.embedTexts(['same input']);
  const different = await provider.embedTexts(['different input']);

  assert.equal(first[0]?.length, 8);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
});

test('prepareDocumentChunks creates stable chunk order and hashes', async () => {
  const parsed = parsedDocument({
    bodyText: 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.',
  });
  const provider = createDeterministicEmbeddingProvider({ dimensions: 4 });
  const embeddings = await provider.embedTexts([
    'Fixture title\n\nAlpha beta gamma.',
    'gamma. Delta epsilon zeta.',
    'zeta. Eta theta iota.',
    'iota. Kappa lambda mu.',
  ]);

  const chunks = prepareDocumentChunks({
    chunkConfig: { maxCharacters: 34, overlapCharacters: 6, version: 'test-chunk-v1' },
    embeddingModel: provider.model,
    embeddings,
    parsed,
    rawContentHash: 'raw-hash-1',
  });

  assert.deepEqual(
    chunks.map((chunk) => ({
      content: chunk.content,
      contentHash: chunk.contentHash,
      index: chunk.chunkIndex,
    })),
    [
      {
        content: 'Fixture title\n\nAlpha beta gamma.',
        contentHash: sha256Hex('0\0Fixture title\n\nAlpha beta gamma.'),
        index: 0,
      },
      {
        content: 'gamma. Delta epsilon zeta.',
        contentHash: sha256Hex('1\0gamma. Delta epsilon zeta.'),
        index: 1,
      },
      {
        content: 'zeta. Eta theta iota.',
        contentHash: sha256Hex('2\0zeta. Eta theta iota.'),
        index: 2,
      },
      {
        content: 'iota. Kappa lambda mu.',
        contentHash: sha256Hex('3\0iota. Kappa lambda mu.'),
        index: 3,
      },
    ],
  );
});

test('prepareDocumentChunks gives repeated chunk content distinct hashes by position', async () => {
  const parsed = parsedDocument({
    bodyText: 'Same repeated sentence.\n\nSame repeated sentence.',
    title: '',
  });
  const provider = createDeterministicEmbeddingProvider({ dimensions: 4 });
  const embeddings = await provider.embedTexts([
    'Same repeated sentence.',
    'Same repeated sentence.',
  ]);

  const chunks = prepareDocumentChunks({
    chunkConfig: { maxCharacters: 24, overlapCharacters: 0, version: 'test-chunk-v1' },
    embeddingModel: provider.model,
    embeddings,
    parsed,
    rawContentHash: 'raw-hash-1',
  });

  assert.deepEqual(
    chunks.map((chunk) => chunk.content),
    ['Same repeated sentence.', 'Same repeated sentence.'],
  );
  assert.equal(new Set(chunks.map((chunk) => chunk.contentHash)).size, chunks.length);
});

test('prepareDocumentChunks skips empty normalized document text', () => {
  const chunks = prepareDocumentChunks({
    chunkConfig: { maxCharacters: 34, overlapCharacters: 6, version: 'test-chunk-v1' },
    embeddingModel: 'deterministic-sha256-v1',
    embeddings: [],
    parsed: parsedDocument({ bodyText: '  \n\t ', title: '   ' }),
    rawContentHash: 'raw-hash-1',
  });

  assert.deepEqual(chunks, []);
});

test('Gemini embedding provider batches requests and preserves vector order', async () => {
  const requestSizes: number[] = [];
  const requestedUrls: string[] = [];
  const requestedApiKeys: Array<string | null> = [];
  const provider = createGeminiEmbeddingProvider({
    apiKey: 'secret',
    dimensions: 1536,
    fetchImpl: async (url, init) => {
      requestedUrls.push(String(url));
      requestedApiKeys.push(new Headers(init?.headers).get('x-goog-api-key'));
      const body = JSON.parse(String(init?.body)) as { requests: Array<unknown> };
      requestSizes.push(body.requests.length);
      const offset = requestSizes.slice(0, -1).reduce((sum, size) => sum + size, 0);

      return Response.json({
        embeddings: body.requests.map((_request, index) => ({
          values: testVector(1536, offset + index),
        })),
      });
    },
    model: 'gemini-embedding-2',
  });

  const texts = Array.from({ length: 205 }, (_value, index) => `text-${index}`);
  const vectors = await provider.embedTexts(texts);

  assert.deepEqual(requestSizes, [100, 100, 5]);
  assert.ok(requestedUrls.every((url) => !url.includes('secret')));
  assert.deepEqual(requestedApiKeys, ['secret', 'secret', 'secret']);
  assert.equal(vectors.length, 205);
  assert.equal(vectors[0]?.[0], 0);
  assert.equal(vectors[204]?.[0], 204);
});

test('Gemini embedding provider does not call API for an empty text list', async () => {
  let fetchCalls = 0;
  const provider = createGeminiEmbeddingProvider({
    apiKey: 'secret',
    dimensions: 1536,
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ embeddings: [] });
    },
    model: 'gemini-embedding-2',
  });

  assert.deepEqual(await provider.embedTexts([]), []);
  assert.equal(fetchCalls, 0);
});

test('chunkAndEmbed upserts a document and does not duplicate unchanged chunks', async () => {
  const repository = new InMemoryChunkEmbeddingRepository([
    {
      parsed: parsedDocument(),
      logicalSourceId: 'logical/fixture-1',
      rawContentHash: 'raw-hash-1',
      rawDocumentId: 'raw-1',
    },
  ]);
  const options = {
    chunkConfig: { maxCharacters: 64, overlapCharacters: 8, version: 'test-chunk-v1' },
    embeddingProvider: createDeterministicEmbeddingProvider({ dimensions: 4 }),
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  };

  const first = await chunkAndEmbed(options);
  const second = await chunkAndEmbed(options);

  assert.equal(first.decisions[0]?.decision, 'indexed');
  assert.equal(second.decisions[0]?.decision, 'unchanged');
  assert.equal(repository.documents.length, 1);
  assert.equal(repository.chunks.length, first.decisions[0]?.chunkCount);
  assert.equal(repository.history.length, 0);
});

test('chunkAndEmbed skips embedding calls when current chunks are unchanged', async () => {
  const repository = new InMemoryChunkEmbeddingRepository([
    {
      parsed: parsedDocument(),
      logicalSourceId: 'logical/fixture-1',
      rawContentHash: 'raw-hash-1',
      rawDocumentId: 'raw-1',
    },
  ]);
  let embedCalls = 0;
  const provider = createDeterministicEmbeddingProvider({ dimensions: 4 });
  const embeddingProvider = {
    ...provider,
    async embedTexts(texts: string[]) {
      embedCalls += 1;
      return provider.embedTexts(texts);
    },
  };
  const options = {
    chunkConfig: { maxCharacters: 64, overlapCharacters: 8, version: 'test-chunk-v1' },
    embeddingProvider,
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  };

  await chunkAndEmbed(options);
  const second = await chunkAndEmbed(options);

  assert.equal(second.decisions[0]?.decision, 'unchanged');
  assert.equal(embedCalls, 1);
});

test('chunkAndEmbed treats unchanged chunks as current when repository order differs', async () => {
  const repository = new InMemoryChunkEmbeddingRepository([
    {
      parsed: parsedDocument({
        bodyText:
          'First paragraph with enough text to create a chunk. Second paragraph with enough text to create another chunk.',
      }),
      logicalSourceId: 'logical/fixture-1',
      rawContentHash: 'raw-hash-1',
      rawDocumentId: 'raw-1',
    },
  ]);
  let embedCalls = 0;
  const provider = createDeterministicEmbeddingProvider({ dimensions: 4 });
  const embeddingProvider = {
    ...provider,
    async embedTexts(texts: string[]) {
      embedCalls += 1;
      return provider.embedTexts(texts);
    },
  };
  const options = {
    chunkConfig: { maxCharacters: 48, overlapCharacters: 0, version: 'test-chunk-v1' },
    embeddingProvider,
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  };

  await chunkAndEmbed(options);
  repository.chunks.reverse();
  const second = await chunkAndEmbed(options);

  assert.equal(second.decisions[0]?.decision, 'unchanged');
  assert.equal(embedCalls, 1);
});

test('chunkAndEmbed archives old chunks when parsed content changes', async () => {
  const repository = new InMemoryChunkEmbeddingRepository([
    {
      parsed: parsedDocument({ bodyText: 'Original body text for chunking.' }),
      logicalSourceId: 'logical/fixture-1',
      rawContentHash: 'raw-hash-1',
      rawDocumentId: 'raw-1',
    },
  ]);
  const options = {
    chunkConfig: { maxCharacters: 64, overlapCharacters: 8, version: 'test-chunk-v1' },
    embeddingProvider: createDeterministicEmbeddingProvider({ dimensions: 4 }),
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  };

  await chunkAndEmbed(options);
  repository.targets[0] = {
    logicalSourceId: 'logical/fixture-1',
    parsed: parsedDocument({ bodyText: 'Updated body text for chunking.' }),
    rawContentHash: 'raw-hash-2',
    rawDocumentId: 'raw-1',
  };
  const updated = await chunkAndEmbed(options);

  assert.equal(updated.decisions[0]?.decision, 'indexed');
  assert.equal(repository.history.length, 1);
  assert.equal(repository.history[0]?.archiveReason, 'document_updated');
  assert.equal(repository.history[0]?.supersededByContentHash, 'raw-hash-2');
  assert.equal(repository.chunks.length, 1);
  assert.equal(repository.chunks[0]?.metadata.rawContentHash, 'raw-hash-2');
});

test('validateGeminiEmbeddingConfig requires a 1536-dimensional Gemini configuration', () => {
  assert.throws(
    () =>
      validateGeminiEmbeddingConfig({
        apiKey: 'secret',
        dimensions: 768,
        model: 'gemini-embedding-2',
      }),
    /GEMINI_EMBEDDING_DIMENSIONS must be 1536/,
  );
  assert.doesNotThrow(() =>
    validateGeminiEmbeddingConfig({
      apiKey: 'secret',
      dimensions: 1536,
      model: 'gemini-embedding-2',
    }),
  );
});

class InMemoryChunkEmbeddingRepository implements ChunkEmbeddingRepository {
  readonly documents: Array<{
    docType: ParsedDocument['docType'];
    graphNodeId: string;
    id: string;
    projectId: string;
    rawDocumentId: string;
  }> = [];
  readonly history: Array<{
    archiveReason: string;
    chunk: PreparedDocumentChunk;
    supersededByContentHash: string;
  }> = [];
  readonly project = { id: 'project-1', slug: 'sample-a' };
  readonly chunks: Array<
    PreparedDocumentChunk & { documentId: string; id: string; projectId: string }
  > = [];

  constructor(readonly targets: ChunkEmbeddingTarget[]) {}

  async lookupProjectBySlug(slug: string) {
    return slug === this.project.slug ? this.project : undefined;
  }

  async readParsedDocuments(input: { limit: number; projectId: string }) {
    assert.equal(input.projectId, this.project.id);
    return this.targets.slice(0, input.limit);
  }

  async upsertDocument(input: UpsertDocumentInput) {
    let document = this.documents.find((item) => item.rawDocumentId === input.rawDocumentId);
    if (!document) {
      document = {
        docType: input.docType,
        graphNodeId: input.graphNodeId,
        id: `document-${this.documents.length + 1}`,
        projectId: input.projectId,
        rawDocumentId: input.rawDocumentId,
      };
      this.documents.push(document);
    } else {
      document.docType = input.docType;
      document.graphNodeId = input.graphNodeId;
    }
    return document;
  }

  async listCurrentChunks(input: { documentId: string; projectId: string }) {
    return this.chunks
      .filter(
        (chunk) => chunk.projectId === input.projectId && chunk.documentId === input.documentId,
      )
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        contentHash: chunk.contentHash,
        embeddingModel: chunk.embeddingModel,
        id: chunk.id,
      }));
  }

  async replaceDocumentChunks(input: ReplaceDocumentChunksInput) {
    const existing = this.chunks.filter(
      (chunk) => chunk.projectId === input.projectId && chunk.documentId === input.documentId,
    );
    for (const chunk of existing) {
      this.history.push({
        archiveReason: input.archiveReason,
        chunk,
        supersededByContentHash: input.supersededByContentHash,
      });
    }
    for (let index = this.chunks.length - 1; index >= 0; index -= 1) {
      const chunk = this.chunks[index];
      if (chunk?.projectId === input.projectId && chunk.documentId === input.documentId) {
        this.chunks.splice(index, 1);
      }
    }
    this.chunks.push(
      ...input.chunks.map((chunk, index) => ({
        ...chunk,
        documentId: input.documentId,
        id: `chunk-${this.chunks.length + index + 1}`,
        projectId: input.projectId,
      })),
    );
  }
}

function parsedDocument(input: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    actors: [],
    bodyText: 'Body text for chunking.',
    canonicalUri: 'https://example.test/doc',
    docType: 'issue',
    metadata: {},
    occurredAt: '2026-05-31T00:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'github:owner/repo#1',
    sourceType: 'github',
    title: 'Fixture title',
    ...input,
  };
}

function testVector(dimensions: number, firstValue: number): number[] {
  return [firstValue, ...Array.from({ length: dimensions - 1 }, () => 0)];
}
