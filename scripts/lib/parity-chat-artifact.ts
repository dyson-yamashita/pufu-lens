import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  type ParityChatPhase,
  parityChatEmbeddingInputs,
  parityChatPlanVersion,
  parityChatTextHash,
} from './parity-chat-inputs.ts';
import {
  type ParityRetrievalInput,
  parityEmbeddingArtifactVersion,
  parityEmbeddingInputs,
  parityEmbeddingSchemaHash,
  parseParityEmbeddingArtifact,
  parseParityEmbeddingVector,
} from './parity-embedding-artifact.ts';
import { parityFixture, parityFixtureHash, parityMappingHash } from './parity-fixture.ts';

export const parityChatArtifactVersion = 'parity-chat-embedding-artifact-v1';
export const parityChatArtifactSchemaHash = parityChatTextHash(
  JSON.stringify({
    version: parityChatArtifactVersion,
    planVersion: parityChatPlanVersion,
    retrieval: 'parity-embedding-artifact-v1',
    query: ['caseId', 'projectId', 'phase', 'text', 'textHash', 'values'],
    vector: 'finite-float32-nonzero-1536',
  }),
);

export type ParityChatArtifactInput = ParityRetrievalInput & {
  chatVector: (caseId: string, projectId: string, phase: ParityChatPhase, text: string) => number[];
};

/** Local generation manifest containing exact synthetic corpus text, never an evaluation report.
 * Optional branches must all be supplied; repeated text must use the same vector throughout.
 */
export function parityChatEmbeddingManifest() {
  const inputs = parityEmbeddingInputs();
  return {
    version: parityChatArtifactVersion,
    schemaHash: parityChatArtifactSchemaHash,
    planVersion: parityChatPlanVersion,
    embedding: parityFixture.embedding,
    retrievalContract: {
      version: parityEmbeddingArtifactVersion,
      fixtureVersion: parityFixture.version,
      fixtureHash: parityFixtureHash,
      schemaVersion: parityFixture.schemaVersion,
      schemaHash: parityEmbeddingSchemaHash,
      mappingHash: parityMappingHash,
    },
    retrievalInputs: {
      chunks: inputs.chunks.map((entry) => ({
        ...entry,
        text: parityFixture.chunks.find((chunk) => chunk.id === entry.id)?.content,
      })),
      queries: inputs.queries.map((entry) => ({
        ...entry,
        text: parityFixture.cases.find((item) => item.id === entry.caseIds[0])?.query,
      })),
    },
    queries: parityChatEmbeddingInputs(),
  };
}

/** Validates the explicit Chat bundle before DB creation. V1 retrieval is nested unchanged.
 * Declared mode and file checksum do not verify origin or semantic quality. No fallback exists.
 */
export function parseParityChatArtifact(json: string) {
  const fail = (): never => {
    throw new Error('Invalid Chat embedding artifact');
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail();
  }
  const { retrieval, queries, ...metadata } = object(raw);
  if (
    !isDeepStrictEqual(metadata, {
      version: parityChatArtifactVersion,
      schemaHash: parityChatArtifactSchemaHash,
      planVersion: parityChatPlanVersion,
    })
  )
    return fail();
  const parsed = parseParityEmbeddingArtifact(JSON.stringify(retrieval));
  const expected = parityChatEmbeddingInputs();
  if (!Array.isArray(queries) || queries.length !== expected.length) return fail();
  const remaining = [...expected];
  const vectors = new Map<string, number[]>();
  const textVectors = new Map<string, number[]>();
  const remember = (hash: string, values: number[]) => {
    const previous = textVectors.get(hash);
    if (previous && !isDeepStrictEqual(previous, values)) return fail();
    textVectors.set(hash, values);
  };
  const retrievalInputs = parityEmbeddingInputs();
  for (const entry of retrievalInputs.chunks)
    remember(entry.textHash, parsed.input.chunkVector(entry.id));
  for (const entry of retrievalInputs.queries)
    remember(entry.textHash, parsed.input.queryVector(entry.caseIds[0] ?? ''));
  const key = (caseId: string, projectId: string, phase: string, text: string) =>
    JSON.stringify([caseId, projectId, phase, text]);
  for (const row of queries) {
    const { values, ...identity } = object(row);
    const index = remaining.findIndex((entry) => isDeepStrictEqual(entry, identity));
    const entry = remaining[index];
    if (!entry) return fail();
    remaining.splice(index, 1);
    const vector = parseParityEmbeddingVector(values);
    remember(entry.textHash, vector);
    vectors.set(key(entry.caseId, entry.projectId, entry.phase, entry.text), vector);
  }
  const checksum = parityChatTextHash(json);
  const input: ParityChatArtifactInput = {
    ...parsed.input,
    inputHash: checksum,
    chatVector(caseId, projectId, phase, text) {
      const vector = vectors.get(key(caseId, projectId, phase, text));
      if (!vector) throw new Error('Unknown Chat embedding artifact input');
      return [...vector];
    },
  };
  return {
    input,
    provenance: {
      ...parsed.provenance,
      version: parityChatArtifactVersion,
      schemaHash: parityChatArtifactSchemaHash,
      planVersion: parityChatPlanVersion,
      checksum,
      retrievalChecksum: parsed.provenance.checksum,
      retrievalChecksumAlgorithm: 'sha256-reserialized-json',
      chatSupported: true,
      queryInputCount: expected.length,
    },
  };
}

/** Reads the opt-in Chat bundle once for identical validated input on both backends. */
export async function readParityChatArtifact(path: string) {
  return parseParityChatArtifact(await readFile(path, 'utf8'));
}
