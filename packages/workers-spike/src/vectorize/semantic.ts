import {
  parseSemanticChunkCandidate,
  type SemanticCandidateRepository,
  type SemanticChunkCandidate,
} from '@pufu-lens/retrieval';
import { type D1Binding, record, rows } from '../d1/binding.js';
import {
  embedding,
  type IndexContract,
  identity,
  type VectorizeBinding,
  verifyIndex,
} from './binding.js';
import { storedSnapshot } from './snapshot.js';

/** Creates a project-scoped adapter with verified cosine/dimension config and required filter evidence.
 * D1 is authoritative for current provenance; metadata never supplies snippets or document fields.
 * Missing/stale matches fail closed as unavailable, so an inconsistent topK is not reported as complete.
 * Supports 1..50 pre-dedupe candidates; larger requests are rejected instead of silently clamped.
 */
export async function createVectorizeCandidateRepository(
  db: D1Binding,
  index: VectorizeBinding,
  config: IndexContract,
): Promise<SemanticCandidateRepository> {
  await verifyIndex(index, config);
  return {
    async search(input) {
      const projectId = identity(input.projectId);
      const values = embedding(input.embedding);
      const topK = input.preDedupLimit ?? input.limit;
      if (
        input.embeddingModel !== config.model ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        !Number.isInteger(topK) ||
        topK < 1 ||
        topK > 50
      )
        throw new Error('Semantic query rejected');
      try {
        const response = record(
          await index.query(values, {
            topK,
            namespace: projectId,
            filter: { projectId, model: config.model },
            returnMetadata: 'all',
            returnValues: false,
          }),
        );
        if (
          !Array.isArray(response.matches) ||
          response.matches.length > topK ||
          response.count !== response.matches.length
        )
          throw new Error('Invalid matches');
        const matches = response.matches.map((value: unknown) => {
          const row = record(value);
          const metadata = record(row.metadata);
          const id = identity(row.id);
          if (
            row.namespace !== projectId ||
            metadata.projectId !== projectId ||
            metadata.model !== config.model ||
            typeof metadata.revision !== 'number' ||
            !Number.isSafeInteger(metadata.revision) ||
            metadata.revision < 1 ||
            typeof row.score !== 'number' ||
            !Number.isFinite(row.score) ||
            row.score < -1 ||
            row.score > 1
          )
            throw new Error('Invalid scoped match');
          return { id, score: row.score, revision: metadata.revision };
        });
        if (new Set(matches.map((m) => m.id)).size !== matches.length)
          throw new Error('Duplicate match');
        if (!matches.length) return [];
        // All hydration rows are read in one D1 statement, scoped before JSON ID matching.
        const result = rows(
          await db
            .prepare(`SELECT DISTINCT v.document_id,v.revision,v.payload FROM semantic_heads h
          JOIN semantic_versions v USING(project_id,document_id,revision), json_each(v.payload,'$.chunks') c
          WHERE h.project_id=?1 AND json_extract(c.value,'$.vectorId') IN
            (SELECT value FROM json_each(?2))`)
            .bind(projectId, JSON.stringify(matches.map((m) => m.id)))
            .all(),
        );
        const candidates = new Map<
          string,
          { revision: number; candidate: SemanticChunkCandidate }
        >();
        for (const value of result) {
          const row = record(value);
          const snapshot = await storedSnapshot(row.payload);
          if (
            snapshot.projectId !== projectId ||
            snapshot.model !== config.model ||
            snapshot.documentId !== row.document_id ||
            snapshot.revision !== row.revision
          )
            throw new Error('Invalid D1 scope');
          for (const chunk of snapshot.chunks) {
            const match = matches.find((m) => m.id === chunk.vectorId);
            if (match)
              candidates.set(match.id, {
                revision: snapshot.revision,
                candidate: parseSemanticChunkCandidate({
                  ...chunk.candidate,
                  cosineDistance: 1 - match.score,
                  rank: 1,
                }),
              });
          }
        }
        const output: SemanticChunkCandidate[] = [];
        const documents = new Set<string>();
        matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const match of matches) {
          const current = candidates.get(match.id);
          if (!current || current.revision !== match.revision)
            throw new Error('Stale Vectorize match');
          const candidate = current.candidate;
          if (!documents.has(candidate.documentId)) {
            documents.add(candidate.documentId);
            output.push({ ...candidate, rank: output.length + 1 });
          }
        }
        return output.slice(0, input.limit);
      } catch {
        throw new Error('Semantic candidate unavailable');
      }
    },
  };
}
