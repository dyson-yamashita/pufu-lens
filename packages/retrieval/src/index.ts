/** Reciprocal-rank offset shared by all Pufu Lens retrieval providers. */
export const RECIPROCAL_RANK_FUSION_K = 60;

/** Provider-neutral display and provenance fields for one ranked document candidate. */
export interface RankedChunkCandidate {
  readonly canonicalUri: string;
  readonly chunkId: string;
  readonly chunkIndex: number;
  readonly documentId: string;
  readonly docType: string;
  readonly rank: number;
  readonly rawDocumentId: string;
  readonly snippet?: string;
  readonly title: string;
}

/** Semantic candidate with a provider-normalized cosine distance used by existing cutoff policy. */
export interface SemanticChunkCandidate extends RankedChunkCandidate {
  readonly cosineDistance: number;
}

/** Final hybrid candidate after provider ranks are fused in Pufu Lens Core. */
export interface FusedChunkCandidate extends Omit<RankedChunkCandidate, 'rank'> {
  readonly cosineDistance?: number;
  readonly fusedScore: number;
  readonly keywordRank?: number;
  readonly semanticRank?: number;
}

/** Project-scoped semantic candidate lookup independent of a vector database API. */
export interface SemanticCandidateRepository {
  search(input: {
    readonly embedding: readonly number[];
    readonly embeddingModel: string;
    readonly limit: number;
    /** Optional bound applied before document dedupe to preserve the current hybrid overfetch policy. */
    readonly preDedupLimit?: number;
    readonly projectId: string;
  }): Promise<readonly SemanticChunkCandidate[]>;
}

/** Project-scoped keyword candidate lookup receiving an already normalized query. */
export interface KeywordCandidateRepository {
  search(input: {
    readonly limit: number;
    readonly normalizedQuery: string;
    readonly projectId: string;
  }): Promise<readonly RankedChunkCandidate[]>;
}

/** Candidate repositories selected together by one deployment composition root. */
export interface CandidateRepositories {
  readonly keywordCandidateRepository: KeywordCandidateRepository;
  readonly semanticCandidateRepository: SemanticCandidateRepository;
}

/**
 * Runtime-validates an untrusted provider result into the canonical ranked candidate DTO.
 *
 * Unknown fields are deliberately discarded so provider scores and response metadata cannot cross
 * the Core boundary.
 *
 * @param value - Untrusted candidate value returned by an adapter
 * @returns A whitelisted provider-neutral candidate
 * @throws When identity, provenance, rank, or display fields are malformed
 */
export function parseRankedChunkCandidate(value: unknown): RankedChunkCandidate {
  const record = requireRecord(value, 'Invalid ranked chunk candidate.');
  const snippet = optionalString(record.snippet, 'snippet');
  return {
    canonicalUri: requireString(record.canonicalUri, 'canonicalUri'),
    chunkId: requireNonBlankString(record.chunkId, 'chunkId'),
    chunkIndex: requireNonNegativeInteger(record.chunkIndex, 'chunkIndex'),
    documentId: requireNonBlankString(record.documentId, 'documentId'),
    docType: requireString(record.docType, 'docType'),
    rank: requirePositiveInteger(record.rank, 'rank'),
    rawDocumentId: requireNonBlankString(record.rawDocumentId, 'rawDocumentId'),
    ...(snippet === undefined ? {} : { snippet }),
    title: requireString(record.title, 'title'),
  };
}

/**
 * Runtime-validates an untrusted semantic provider result after metric normalization.
 *
 * @param value - Untrusted semantic candidate value returned by an adapter
 * @returns A ranked candidate with a finite non-negative cosine distance
 * @throws When the base candidate or normalized metric is malformed
 */
export function parseSemanticChunkCandidate(value: unknown): SemanticChunkCandidate {
  const record = requireRecord(value, 'Invalid semantic chunk candidate.');
  return {
    ...parseRankedChunkCandidate(record),
    cosineDistance: requireNonNegativeFiniteNumber(record.cosineDistance, 'cosineDistance'),
  };
}

/**
 * Returns one weighted reciprocal-rank contribution for a one-based candidate rank.
 *
 * @param rank - One-based position in a provider ranking
 * @param weight - Positive relative weight for the ranking
 * @returns The deterministic contribution, or zero for invalid input
 */
export function reciprocalRankFusionScore(rank: number, weight = 1): number {
  if (!Number.isInteger(rank) || rank < 1 || !Number.isFinite(weight) || weight <= 0) {
    return 0;
  }
  return weight / (RECIPROCAL_RANK_FUSION_K + rank);
}

/**
 * Fuses semantic and keyword document rankings without comparing provider-specific raw scores.
 *
 * The lower provider rank selects display chunk provenance; semantic provenance wins an equal-rank
 * tie. Results are ordered by the legacy SQL policy: fused score, best rank, then document id.
 *
 * @param input - Ranked provider candidates and final document limit
 * @returns Deduplicated hybrid candidates in deterministic best-first order
 */
export function fuseRankedChunkCandidates(input: {
  readonly keywordCandidates: readonly RankedChunkCandidate[];
  readonly limit: number;
  readonly semanticCandidates: readonly SemanticChunkCandidate[];
}): FusedChunkCandidate[] {
  const semanticByDocument = lowestRankedByDocument(input.semanticCandidates);
  const keywordByDocument = lowestRankedByDocument(input.keywordCandidates);
  const documentIds = new Set([...semanticByDocument.keys(), ...keywordByDocument.keys()]);
  const fused: FusedChunkCandidate[] = [];

  for (const documentId of documentIds) {
    const semantic = semanticByDocument.get(documentId);
    const keyword = keywordByDocument.get(documentId);
    if (!semantic && !keyword) continue;
    const display = semantic && (!keyword || semantic.rank <= keyword.rank) ? semantic : keyword;
    if (!display) continue;
    fused.push({
      canonicalUri: display.canonicalUri,
      chunkId: display.chunkId,
      chunkIndex: display.chunkIndex,
      documentId: display.documentId,
      docType: display.docType,
      fusedScore:
        reciprocalRankFusionScore(semantic?.rank ?? 0) +
        reciprocalRankFusionScore(keyword?.rank ?? 0),
      ...(semantic ? { cosineDistance: semantic.cosineDistance, semanticRank: semantic.rank } : {}),
      ...(keyword ? { keywordRank: keyword.rank } : {}),
      rawDocumentId: display.rawDocumentId,
      ...(display.snippet === undefined ? {} : { snippet: display.snippet }),
      title: display.title,
    });
  }

  return fused
    .sort((left, right) => {
      const leftBestRank = Math.min(
        left.semanticRank ?? Number.POSITIVE_INFINITY,
        left.keywordRank ?? Number.POSITIVE_INFINITY,
      );
      const rightBestRank = Math.min(
        right.semanticRank ?? Number.POSITIVE_INFINITY,
        right.keywordRank ?? Number.POSITIVE_INFINITY,
      );
      return (
        right.fusedScore - left.fusedScore ||
        leftBestRank - rightBestRank ||
        compareCodeUnitStrings(left.documentId, right.documentId)
      );
    })
    .slice(0, Math.max(0, input.limit));
}

function lowestRankedByDocument<T extends RankedChunkCandidate>(
  candidates: readonly T[],
): Map<string, T> {
  const selected = new Map<string, T>();
  for (const candidateValue of candidates) {
    const candidate = candidateValue;
    const previous = selected.get(candidate.documentId);
    if (
      !previous ||
      candidate.rank < previous.rank ||
      (candidate.rank === previous.rank && candidate.chunkId < previous.chunkId)
    ) {
      selected.set(candidate.documentId, candidate);
    }
  }
  return selected;
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid candidate field: ${fieldName}`);
  return value;
}

function requireNonBlankString(value: unknown, fieldName: string): string {
  const parsed = requireString(value, fieldName);
  if (parsed.trim().length === 0) throw new Error(`Invalid candidate field: ${fieldName}`);
  return parsed;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, fieldName);
}

function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid candidate field: ${fieldName}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid candidate field: ${fieldName}`);
  }
  return value;
}

function requireNonNegativeFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid candidate field: ${fieldName}`);
  }
  return value;
}
