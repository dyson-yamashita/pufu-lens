import type { RankedChunkCandidate, SemanticChunkCandidate } from '@pufu-lens/retrieval';
import { parseRankedChunkCandidate, parseSemanticChunkCandidate } from '@pufu-lens/retrieval';

/** Parses and validates a pgvector row before it crosses the Postgres adapter boundary. */
export function parsePostgresSemanticCandidateRow(value: unknown): SemanticChunkCandidate {
  const record = requireRow(value);
  return parseSemanticChunkCandidate({
    ...baseCandidateFromRow(record),
    cosineDistance: requireFiniteNumber(record.cosine_distance, 'cosine_distance'),
    rank: requirePositiveInteger(record.rank, 'rank'),
  });
}

/** Parses and validates a keyword row while discarding provider-specific score fields. */
export function parsePostgresKeywordCandidateRow(value: unknown): RankedChunkCandidate {
  const record = requireRow(value);
  return parseRankedChunkCandidate({
    ...baseCandidateFromRow(record),
    rank: requirePositiveInteger(record.rank, 'rank'),
  });
}

function baseCandidateFromRow(record: Record<string, unknown>) {
  const snippet = requireOptionalNullableString(record.snippet, 'snippet');
  return {
    canonicalUri: requireString(record.canonical_uri, 'canonical_uri'),
    chunkId: requireString(record.chunk_id, 'chunk_id'),
    chunkIndex: requireNonNegativeInteger(record.chunk_index, 'chunk_index'),
    documentId: requireString(record.document_id, 'document_id'),
    docType: requireString(record.doc_type, 'doc_type'),
    rawDocumentId: requireString(record.raw_document_id, 'raw_document_id'),
    ...(snippet === null || snippet === undefined ? {} : { snippet }),
    title: requireString(record.title, 'title'),
  };
}

function requireRow(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Postgres candidate row.');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Postgres candidate row field: ${fieldName}`);
  }
  return value;
}

function requireOptionalNullableString(
  value: unknown,
  fieldName: string,
): string | null | undefined {
  if (value === undefined || value === null || typeof value === 'string') return value;
  throw new Error(`Invalid Postgres candidate row field: ${fieldName}`);
}

function requireFiniteNumber(value: unknown, fieldName: string): number {
  const parsed = parseDatabaseNumber(value);
  if (parsed === undefined || !Number.isFinite(parsed)) {
    throw new Error(`Invalid Postgres candidate row field: ${fieldName}`);
  }
  return parsed;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  const parsed = parseDatabaseNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid Postgres candidate row field: ${fieldName}`);
  }
  return parsed;
}

function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = parseDatabaseNumber(value);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid Postgres candidate row field: ${fieldName}`);
  }
  return parsed;
}

function parseDatabaseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim().length > 0) return Number(value);
  return undefined;
}
