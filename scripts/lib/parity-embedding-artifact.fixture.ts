import {
  parityEmbeddingArtifactVersion,
  parityEmbeddingInputs,
  parityEmbeddingSchemaHash,
} from './parity-embedding-artifact.ts';
import { parityFixture, parityFixtureHash, parityMappingHash } from './parity-fixture.ts';
import { syntheticParityVector } from './parity-retrieval.ts';

/** Test-only saved vectors: deliberately synthetic, different from the default projection. */
export function syntheticEmbeddingArtifactFixture() {
  const inputs = parityEmbeddingInputs();
  return {
    version: parityEmbeddingArtifactVersion,
    fixtureVersion: parityFixture.version,
    fixtureHash: parityFixtureHash,
    schemaVersion: parityFixture.schemaVersion,
    schemaHash: parityEmbeddingSchemaHash,
    mappingHash: parityMappingHash,
    embedding: { ...parityFixture.embedding, mode: 'synthetic' },
    chunks: inputs.chunks.map((entry) => ({
      ...entry,
      values: syntheticParityVector(`artifact-test:${entry.textHash}`),
    })),
    queries: inputs.queries.map((entry) => ({
      ...entry,
      values: syntheticParityVector(`artifact-test:${entry.textHash}`),
    })),
  };
}
