import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { parityFixture, parityFixtureHash, parityMappingHash } from './parity-fixture.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const parityEmbeddingArtifactVersion = 'parity-embedding-artifact-v1';
export const parityEmbeddingSchemaHash = hash(
  JSON.stringify({
    version: parityEmbeddingArtifactVersion,
    chunk: ['id', 'documentId', 'projectId', 'textHash', 'values'],
    query: ['caseIds', 'projectId', 'textHash', 'values'],
    textHash: 'sha256-utf8-exact',
    vector: 'finite-float32-nonzero-1536',
  }),
);

/** Describes exact fixture input identities without exposing text or reading relevance labels. */
export function parityEmbeddingInputs() {
  const queries = new Map<string, { caseIds: string[]; projectId: string; textHash: string }>();
  for (const item of parityFixture.cases.filter(
    (c) => c.kind === 'semantic' || c.kind === 'hybrid',
  )) {
    const key = `${item.projectId}:${hash(item.query)}`;
    const query = queries.get(key) ?? {
      caseIds: [],
      projectId: item.projectId,
      textHash: hash(item.query),
    };
    query.caseIds.push(item.id);
    queries.set(key, query);
  }
  return {
    chunks: parityFixture.chunks.map(({ id, documentId, projectId, content }) => ({
      id,
      documentId,
      projectId,
      textHash: hash(content),
    })),
    queries: [...queries.values()],
  };
}

export type ParityRetrievalInput = {
  embedding: { mode: 'real' | 'synthetic'; model: string; dimensions: number; metric: string };
  inputHash: string;
  chunkVector: (id: string) => number[];
  queryVector: (caseId: string) => number[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid embedding artifact object');
  return value as Record<string, unknown>;
}

/** Validates the saved JSON before any DB work. Metadata is a declaration, never proof of origin.
 * Requires complete exact input coverage and float32-safe cosine vectors; errors never echo input.
 */
export function parseParityEmbeddingArtifact(json: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Invalid embedding artifact JSON');
  }
  const { chunks, queries, embedding: rawEmbedding, ...metadata } = object(raw);
  if (
    !isDeepStrictEqual(metadata, {
      version: parityEmbeddingArtifactVersion,
      fixtureVersion: parityFixture.version,
      fixtureHash: parityFixtureHash,
      schemaVersion: parityFixture.schemaVersion,
      schemaHash: parityEmbeddingSchemaHash,
      mappingHash: parityMappingHash,
    })
  )
    throw new Error('Invalid embedding artifact contract');
  const embedding = object(rawEmbedding);
  if (
    (embedding.mode !== 'real' && embedding.mode !== 'synthetic') ||
    !isDeepStrictEqual(embedding, {
      ...parityFixture.embedding,
      mode: embedding.mode,
    })
  )
    throw new Error('Invalid embedding artifact embedding contract');
  const inputs = parityEmbeddingInputs();
  const vectors = new Map<string, number[]>();
  for (const [rows, expected, kind] of [
    [chunks, inputs.chunks, 'chunk'],
    [queries, inputs.queries, 'query'],
  ] as const) {
    if (!Array.isArray(rows) || rows.length !== expected.length)
      throw new Error('Invalid embedding artifact coverage');
    const remaining = [...expected];
    for (const row of rows) {
      const { values, ...identity } = object(row);
      const index = remaining.findIndex((entry) => isDeepStrictEqual(entry, identity));
      if (index < 0) throw new Error('Invalid embedding artifact identity/duplicate');
      remaining.splice(index, 1);
      if (
        !Array.isArray(values) ||
        values.length !== 1536 ||
        values.some(
          (v) => typeof v !== 'number' || !Number.isFinite(v) || !Number.isFinite(Math.fround(v)),
        ) ||
        Math.hypot(...values.map(Math.fround)) === 0
      )
        throw new Error('Invalid embedding artifact vector');
      const keys = kind === 'chunk' ? [identity.id] : identity.caseIds;
      if (!Array.isArray(keys)) throw new Error('Invalid embedding artifact keys');
      for (const key of keys) vectors.set(`${kind}:${key}`, [...values]);
    }
  }
  const checksum = hash(json);
  const get = (key: string) => {
    const vector = vectors.get(key);
    if (!vector) throw new Error('Missing embedding artifact input');
    return [...vector];
  };
  const input: ParityRetrievalInput = {
    embedding: { ...parityFixture.embedding, mode: embedding.mode },
    inputHash: checksum,
    chunkVector: (id) => get(`chunk:${id}`),
    queryVector: (id) => get(`query:${id}`),
  };
  return {
    input,
    provenance: {
      source: 'saved-artifact',
      checksum,
      checksumAlgorithm: 'sha256-utf8-file',
      version: parityEmbeddingArtifactVersion,
      fixtureHash: parityFixtureHash,
      schemaHash: parityEmbeddingSchemaHash,
      mappingHash: parityMappingHash,
      declaredEmbedding: input.embedding,
      originVerified: false,
      semanticQualityMeasured: false,
      chatSupported: false,
    },
  };
}

/** Reads one local artifact once so both backend collectors share identical validated values. */
export async function readParityEmbeddingArtifact(path: string) {
  return parseParityEmbeddingArtifact(await readFile(path, 'utf8'));
}
