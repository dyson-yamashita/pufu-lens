import { parityChatEmbeddingManifest } from './parity-chat-artifact.ts';
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

/** Explicit synthetic Chat bundle; vectors depend only on exact input hashes, never expectations. */
export function syntheticChatArtifactFixture(
  projection: 'artifact-hash' | 'default-text' = 'artifact-hash',
) {
  const manifest = parityChatEmbeddingManifest();
  const retrieval = syntheticEmbeddingArtifactFixture();
  if (projection === 'default-text') {
    for (const chunk of retrieval.chunks) {
      const text = manifest.retrievalInputs.chunks.find((entry) => entry.id === chunk.id)?.text;
      if (text === undefined) throw new Error('Missing synthetic input text');
      chunk.values = syntheticParityVector(text);
    }
    for (const query of retrieval.queries) {
      const text = manifest.retrievalInputs.queries.find(
        (entry) => entry.textHash === query.textHash,
      )?.text;
      if (text === undefined) throw new Error('Missing synthetic input text');
      query.values = syntheticParityVector(text);
    }
  }
  return {
    version: manifest.version,
    schemaHash: manifest.schemaHash,
    planVersion: manifest.planVersion,
    retrieval,
    queries: manifest.queries.map((entry) => ({
      ...entry,
      values: syntheticParityVector(
        projection === 'default-text' ? entry.text : `artifact-test:${entry.textHash}`,
      ),
    })),
  };
}
