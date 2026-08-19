import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fuseRankedChunkCandidates,
  parseRankedChunkCandidate,
  parseSemanticChunkCandidate,
  RECIPROCAL_RANK_FUSION_K,
  reciprocalRankFusionScore,
} from './index.js';

function buildRankedCandidateInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    canonicalUri: 'https://example.test/doc-a',
    chunkId: 'chunk-a-0',
    chunkIndex: 0,
    documentId: 'doc-a',
    docType: 'web_page',
    rawDocumentId: 'raw-a',
    rank: 1,
    snippet: 'snippet a',
    title: 'Document A',
    ...overrides,
  };
}

function buildSemanticCandidateInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildRankedCandidateInput({
    cosineDistance: 0.18,
    ...overrides,
  });
}

test('RECIPROCAL_RANK_FUSION_K is fixed at 60', () => {
  assert.equal(RECIPROCAL_RANK_FUSION_K, 60);
});

test('reciprocalRankFusionScore returns weighted RRF contribution for valid one-based ranks', () => {
  assert.equal(reciprocalRankFusionScore(1), 1 / 61);
  assert.equal(reciprocalRankFusionScore(2), 1 / 62);
  assert.equal(reciprocalRankFusionScore(1, 2), 2 / 61);
  assert.ok(reciprocalRankFusionScore(1) > reciprocalRankFusionScore(2));
});

test('reciprocalRankFusionScore returns zero for invalid rank or weight', () => {
  assert.equal(reciprocalRankFusionScore(0), 0);
  assert.equal(reciprocalRankFusionScore(-1), 0);
  assert.equal(reciprocalRankFusionScore(1.5), 0);
  assert.equal(reciprocalRankFusionScore(1, 0), 0);
  assert.equal(reciprocalRankFusionScore(1, -1), 0);
  assert.equal(reciprocalRankFusionScore(1, Number.NaN), 0);
});

test('parseRankedChunkCandidate returns a whitelisted provider-neutral DTO', () => {
  const parsed = parseRankedChunkCandidate(
    buildRankedCandidateInput({
      providerScore: 0.99,
      keywordScore: 12,
      vectorDistance: 0.2,
    }),
  );

  assert.deepEqual(parsed, {
    canonicalUri: 'https://example.test/doc-a',
    chunkId: 'chunk-a-0',
    chunkIndex: 0,
    documentId: 'doc-a',
    docType: 'web_page',
    rawDocumentId: 'raw-a',
    rank: 1,
    snippet: 'snippet a',
    title: 'Document A',
  });
  assert.equal('providerScore' in parsed, false);
  assert.equal('keywordScore' in parsed, false);
  assert.equal('vectorDistance' in parsed, false);
});

test('parseRankedChunkCandidate rejects invalid rank, identifiers, provenance, and malformed input', () => {
  assert.throws(() => parseRankedChunkCandidate(null), /Invalid ranked chunk candidate/);
  assert.throws(() => parseRankedChunkCandidate(buildRankedCandidateInput({ rank: 0 })), /rank/);
  assert.throws(
    () => parseRankedChunkCandidate(buildRankedCandidateInput({ documentId: '  ' })),
    /documentId/,
  );
  assert.throws(
    () => parseRankedChunkCandidate(buildRankedCandidateInput({ chunkId: '' })),
    /chunkId/,
  );
  assert.throws(
    () =>
      parseRankedChunkCandidate(
        buildRankedCandidateInput({ chunkIndex: undefined, chunkId: undefined }),
      ),
    /chunk/,
  );
  assert.throws(
    () => parseRankedChunkCandidate(buildRankedCandidateInput({ chunkIndex: -1 })),
    /chunkIndex/,
  );
  assert.throws(
    () => parseRankedChunkCandidate(buildRankedCandidateInput({ chunkIndex: 1.5 })),
    /chunkIndex/,
  );
  assert.throws(
    () => parseRankedChunkCandidate(buildRankedCandidateInput({ rawDocumentId: '' })),
    /rawDocumentId/,
  );
});

test('parseRankedChunkCandidate preserves an empty canonical URI for current GCP rows', () => {
  assert.equal(
    parseRankedChunkCandidate(buildRankedCandidateInput({ canonicalUri: '' })).canonicalUri,
    '',
  );
});

test('parseSemanticChunkCandidate returns ranked DTO with finite non-negative cosineDistance', () => {
  const parsed = parseSemanticChunkCandidate(
    buildSemanticCandidateInput({
      distance: 0.33,
      providerScore: 9,
    }),
  );

  assert.equal(parsed.cosineDistance, 0.18);
  assert.equal(parsed.rank, 1);
  assert.equal('distance' in parsed, false);
  assert.equal('providerScore' in parsed, false);
});

test('parseSemanticChunkCandidate rejects missing or invalid cosine distance', () => {
  assert.throws(
    () => parseSemanticChunkCandidate(buildSemanticCandidateInput({ cosineDistance: undefined })),
    /cosineDistance/,
  );
  assert.throws(
    () => parseSemanticChunkCandidate(buildSemanticCandidateInput({ cosineDistance: -0.1 })),
    /cosineDistance/,
  );
  assert.throws(
    () =>
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({ cosineDistance: Number.POSITIVE_INFINITY }),
      ),
    /cosineDistance/,
  );
  assert.throws(
    () => parseSemanticChunkCandidate(buildSemanticCandidateInput({ cosineDistance: Number.NaN })),
    /cosineDistance/,
  );
});

test('fuseRankedChunkCandidates dedupes by document and sums unnormalized RRF contributions', () => {
  const fused = fuseRankedChunkCandidates({
    keywordCandidates: [
      parseRankedChunkCandidate(
        buildRankedCandidateInput({
          canonicalUri: 'https://example.test/shared',
          chunkId: 'chunk-shared-k',
          chunkIndex: 2,
          documentId: 'doc-shared',
          rank: 2,
          rawDocumentId: 'raw-shared',
          snippet: 'keyword snippet',
          title: 'Shared Document',
        }),
      ),
    ],
    limit: 5,
    semanticCandidates: [
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          canonicalUri: 'https://example.test/shared',
          chunkId: 'chunk-shared-s',
          chunkIndex: 1,
          cosineDistance: 0.11,
          documentId: 'doc-shared',
          rank: 1,
          rawDocumentId: 'raw-shared',
          snippet: 'semantic snippet',
          title: 'Shared Document',
        }),
      ),
    ],
  });

  assert.equal(fused.length, 1);
  assert.equal(fused[0]?.documentId, 'doc-shared');
  assert.equal(fused[0]?.semanticRank, 1);
  assert.equal(fused[0]?.keywordRank, 2);
  assert.equal(fused[0]?.fusedScore, reciprocalRankFusionScore(1) + reciprocalRankFusionScore(2));
  assert.equal(fused[0]?.chunkId, 'chunk-shared-s');
  assert.equal(fused[0]?.chunkIndex, 1);
  assert.equal(fused[0]?.snippet, 'semantic snippet');
  assert.equal(fused[0]?.cosineDistance, 0.11);
});

test('fuseRankedChunkCandidates chooses keyword provenance on cross-chunk consensus when keyword rank is lower', () => {
  const fused = fuseRankedChunkCandidates({
    keywordCandidates: [
      parseRankedChunkCandidate(
        buildRankedCandidateInput({
          canonicalUri: 'https://example.test/consensus',
          chunkId: 'chunk-consensus-k',
          chunkIndex: 4,
          documentId: 'doc-consensus',
          rank: 1,
          rawDocumentId: 'raw-consensus',
          snippet: 'keyword winning snippet',
          title: 'Consensus Document',
        }),
      ),
    ],
    limit: 5,
    semanticCandidates: [
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          canonicalUri: 'https://example.test/consensus',
          chunkId: 'chunk-consensus-s',
          chunkIndex: 2,
          cosineDistance: 0.07,
          documentId: 'doc-consensus',
          rank: 3,
          rawDocumentId: 'raw-consensus',
          snippet: 'semantic losing snippet',
          title: 'Consensus Document',
        }),
      ),
    ],
  });

  assert.equal(fused[0]?.chunkId, 'chunk-consensus-k');
  assert.equal(fused[0]?.chunkIndex, 4);
  assert.equal(fused[0]?.snippet, 'keyword winning snippet');
  assert.equal(fused[0]?.semanticRank, 3);
  assert.equal(fused[0]?.keywordRank, 1);
  assert.equal(fused[0]?.cosineDistance, 0.07);
});

test('fuseRankedChunkCandidates prefers semantic provenance when provider ranks tie', () => {
  const fused = fuseRankedChunkCandidates({
    keywordCandidates: [
      parseRankedChunkCandidate(
        buildRankedCandidateInput({
          canonicalUri: 'https://example.test/tie',
          chunkId: 'chunk-tie-k',
          chunkIndex: 9,
          documentId: 'doc-tie',
          rank: 2,
          rawDocumentId: 'raw-tie',
          snippet: 'keyword tie snippet',
          title: 'Tie Document',
        }),
      ),
    ],
    limit: 5,
    semanticCandidates: [
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          canonicalUri: 'https://example.test/tie',
          chunkId: 'chunk-tie-s',
          chunkIndex: 5,
          cosineDistance: 0.2,
          documentId: 'doc-tie',
          rank: 2,
          rawDocumentId: 'raw-tie',
          snippet: 'semantic tie snippet',
          title: 'Tie Document',
        }),
      ),
    ],
  });

  assert.equal(fused[0]?.chunkId, 'chunk-tie-s');
  assert.equal(fused[0]?.chunkIndex, 5);
  assert.equal(fused[0]?.snippet, 'semantic tie snippet');
  assert.equal(fused[0]?.semanticRank, 2);
  assert.equal(fused[0]?.keywordRank, 2);
});

test('fuseRankedChunkCandidates sorts by fused score, best rank, then documentId with deterministic ties', () => {
  const fused = fuseRankedChunkCandidates({
    keywordCandidates: [
      parseRankedChunkCandidate(
        buildRankedCandidateInput({
          canonicalUri: 'https://example.test/doc-b',
          chunkId: 'chunk-b-k',
          chunkIndex: 1,
          documentId: 'doc-b',
          rank: 1,
          rawDocumentId: 'raw-b',
          snippet: 'b keyword',
          title: 'Document B',
        }),
      ),
      parseRankedChunkCandidate(
        buildRankedCandidateInput({
          canonicalUri: 'https://example.test/doc-a',
          chunkId: 'chunk-a-k',
          chunkIndex: 3,
          documentId: 'doc-a',
          rank: 4,
          rawDocumentId: 'raw-a',
          snippet: 'a keyword',
          title: 'Document A',
        }),
      ),
    ],
    limit: 10,
    semanticCandidates: [
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          canonicalUri: 'https://example.test/doc-a',
          chunkId: 'chunk-a-s',
          chunkIndex: 0,
          cosineDistance: 0.4,
          documentId: 'doc-a',
          rank: 1,
          rawDocumentId: 'raw-a',
          snippet: 'a semantic',
          title: 'Document A',
        }),
      ),
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          canonicalUri: 'https://example.test/doc-z',
          chunkId: 'chunk-z-s',
          chunkIndex: 0,
          cosineDistance: 0.9,
          documentId: 'doc-z',
          rank: 1,
          rawDocumentId: 'raw-z',
          snippet: 'z semantic',
          title: 'Document Z',
        }),
      ),
    ],
  });

  assert.deepEqual(
    fused.map((candidate) => candidate.documentId),
    ['doc-a', 'doc-b', 'doc-z'],
  );
  assert.equal(fused[0]?.semanticRank, 1);
  assert.equal(fused[0]?.keywordRank, 4);
  assert.equal(fused[0]?.chunkId, 'chunk-a-s');
  assert.equal(fused[0]?.chunkIndex, 0);
  assert.equal(fused[0]?.snippet, 'a semantic');
  assert.equal(fused[1]?.semanticRank, undefined);
  assert.equal(fused[1]?.keywordRank, 1);
  assert.equal(fused[1]?.chunkId, 'chunk-b-k');
  assert.equal(fused[2]?.semanticRank, 1);
  assert.equal(fused[2]?.keywordRank, undefined);
  assert.equal(fused[1]?.fusedScore, reciprocalRankFusionScore(1));
  assert.equal(fused[2]?.fusedScore, reciprocalRankFusionScore(1));
});

test('fuseRankedChunkCandidates uses locale-independent code-unit order for documentId ties', () => {
  const fused = fuseRankedChunkCandidates({
    keywordCandidates: [],
    limit: 10,
    semanticCandidates: [
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          chunkId: 'chunk-underscore',
          documentId: 'doc_underscore',
          rawDocumentId: 'raw-underscore',
          rank: 1,
        }),
      ),
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          chunkId: 'chunk-hyphen',
          documentId: 'doc-hyphen',
          rawDocumentId: 'raw-hyphen',
          rank: 1,
        }),
      ),
    ],
  });

  assert.deepEqual(
    fused.map((candidate) => candidate.documentId),
    ['doc-hyphen', 'doc_underscore'],
  );
});

test('fuseRankedChunkCandidates respects non-negative limit', () => {
  const fused = fuseRankedChunkCandidates({
    keywordCandidates: [],
    limit: 0,
    semanticCandidates: [
      parseSemanticChunkCandidate(buildSemanticCandidateInput()),
      parseSemanticChunkCandidate(
        buildSemanticCandidateInput({
          canonicalUri: 'https://example.test/doc-b',
          chunkId: 'chunk-b-0',
          documentId: 'doc-b',
          rank: 2,
          rawDocumentId: 'raw-b',
          title: 'Document B',
        }),
      ),
    ],
  });

  assert.deepEqual(fused, []);
  assert.deepEqual(
    fuseRankedChunkCandidates({
      keywordCandidates: [],
      limit: -1,
      semanticCandidates: [parseSemanticChunkCandidate(buildSemanticCandidateInput())],
    }),
    [],
  );
});
