import { collectSyntheticChat, parityChatInputs } from '../../scripts/lib/parity-chat.ts';
import { syntheticEmbedding, syntheticParityVector } from '../../scripts/lib/parity-retrieval.ts';
import { withD1ParityCandidates } from './parity-retrieval-local.mjs';

/** Runs Chat selection on real D1 candidates, then injects stale Vectorize metadata into the adapter.
 * The adapter's observed unavailable error is retained, never relabeled from the expected outcome.
 */
export async function collectD1SyntheticChat() {
  return withD1ParityCandidates(async (repositories, faults) => {
    const result = await collectSyntheticChat(repositories);
    const input = parityChatInputs().find((input) => input.id === 'failure-stale_read');
    if (!input) throw new Error('Missing stale fixture input');
    const query = {
      projectId: input.projectId,
      embedding: syntheticParityVector(input.question),
      embeddingModel: syntheticEmbedding.model,
      limit: 10,
      preDedupLimit: 37,
    };
    const before = await repositories.semanticCandidateRepository.search(query);
    let actualError = null;
    let returnedCandidates = null;
    faults.setStale(true);
    try {
      returnedCandidates = (await repositories.semanticCandidateRepository.search(query)).length;
    } catch (error) {
      actualError =
        error instanceof Error && error.message === 'unavailable' ? 'unavailable' : 'unexpected';
    } finally {
      faults.setStale(false);
    }
    const after = await repositories.semanticCandidateRepository.search(query);
    return {
      ...result,
      staleRead: {
        id: input.id,
        actualError,
        returnedCandidates,
        boundary: 'real-d1-workerd-vectorize-revision-check',
        fault: 'fake-vectorize-match-revision-plus-one',
        controlBeforeCount: before.length,
        controlAfterCount: after.length,
        scopePass: null,
        mutationPass: null,
        rubricPass: null,
      },
    };
  });
}
