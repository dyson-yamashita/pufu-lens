import { parseRankedChunkCandidate, type RankedChunkCandidate } from '@pufu-lens/retrieval';
import { record, text } from '../d1/binding.js';
import { embedding, identity, vectorId } from './binding.js';

export interface Snapshot {
  projectId: string;
  documentId: string;
  revision: number;
  model: string;
  chunks: { candidate: RankedChunkCandidate; values: number[]; vectorId: string }[];
}

/** Validates a complete immutable revision. Empty chunks are a tombstone; revisions never get reused.
 * Callers must allocate monotonic document revisions at the source, including manual reindex.
 * This spike stores at most 100 KB per snapshot and 16 chunks; it is not a general ingestion API.
 */
export async function parseSnapshot(value: unknown): Promise<Snapshot> {
  const input = record(value);
  const projectId = identity(input.projectId);
  const documentId = text(input.documentId);
  const model = identity(input.model);
  const revision = input.revision;
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Array.isArray(input.chunks) ||
    input.chunks.length > 16
  )
    throw new Error('Invalid snapshot');
  const chunks = await Promise.all(
    input.chunks.map(async (item: unknown) => {
      const row = record(item);
      const candidate = parseRankedChunkCandidate({ ...record(row.candidate), rank: 1 });
      if (candidate.documentId !== documentId) throw new Error('Snapshot document mismatch');
      return {
        candidate,
        values: embedding(row.values),
        vectorId: await vectorId(projectId, documentId, revision, candidate.chunkId),
      };
    }),
  );
  if (
    new Set(chunks.map((c) => c.candidate.chunkId)).size !== chunks.length ||
    new Set(chunks.map((c) => c.candidate.chunkIndex)).size !== chunks.length
  )
    throw new Error('Duplicate snapshot chunk');
  const result = { projectId, documentId, revision, model, chunks };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 100_000)
    throw new Error('Snapshot too large');
  return result;
}

/** Revalidates persisted JSON, including its derived IDs, before returning D1 data to an adapter. */
export async function storedSnapshot(value: unknown): Promise<Snapshot> {
  if (typeof value !== 'string') throw new Error('Invalid snapshot row');
  const snapshot = await parseSnapshot(JSON.parse(value));
  if (JSON.stringify(snapshot) !== value) throw new Error('Corrupt snapshot');
  return snapshot;
}
