import type { GraphMutationRepository, GraphReadRepository } from '@pufu-lens/graph';
import { type ChatRepository, GRAPH_RELATION_POOL_LIMITS } from '../../apps/web/src/chat.ts';

/** Independent wiring fixture, not v1 judgments or an answer-quality oracle. */
export const chatGraphConnectionFixture = {
  version: 'chat-graph-connection-v1',
  projectId: 'alpha',
  documents: ['d01', 'd02', 'd03'],
  edges: [
    ['d01', 'SAME_AS', 'd02'],
    ['d02', 'RELATED_TO', 'd03'],
    ['d01', 'MENTIONS', 'topic:connection'],
    ['d03', 'MENTIONS', 'topic:connection'],
  ],
} as const;

/** Seeds only an explicitly separate connection fixture through existing mutation adapters. */
export async function seedChatConnectionGraph(
  mutation: Pick<GraphMutationRepository, 'upsertNode' | 'upsertEdge'>,
) {
  const { projectId, documents, edges } = chatGraphConnectionFixture;
  for (const id of [...documents, 'topic:connection']) {
    const topic = id.startsWith('topic:');
    await mutation.upsertNode({
      projectId,
      graphNodeId: id,
      labels: [topic ? 'Topic' : 'Document'],
      properties: topic
        ? { name: 'connection', topicType: 'concept' }
        : { documentId: id, docType: 'web_page' },
    });
  }
  for (const [fromGraphNodeId, relationType, toGraphNodeId] of edges)
    await mutation.upsertEdge({
      projectId,
      fromGraphNodeId,
      relationType,
      toGraphNodeId,
      properties: {},
    });
}

/** Local D1 bridge: real Graph candidates plus DB hydration feed the existing Node coverage pass.
 * This is not a production Cloudflare Chat repository or an authorization boundary.
 */
export function localGraphCoverageQuery(
  read: Pick<GraphReadRepository, 'findRelatedDocuments'>,
  documentFetch: ChatRepository['documentFetch'],
): ChatRepository['graphCoverageQuery'] {
  return async ({ projectId, seedDocumentIds }) => {
    const result = await read.findRelatedDocuments({
      projectId,
      seedDocumentIds,
      relationLimits: GRAPH_RELATION_POOL_LIMITS,
    });
    const counts = { SAME_AS: 0, RELATED_TO: 0, MENTIONS: 0 };
    if (result.status === 'unavailable')
      return { candidates: [], queryFailed: true, relationCandidateCounts: counts };
    const sources = await documentFetch({
      projectId,
      documentIds: result.candidates.map((c) => c.documentId),
    });
    const candidates = result.candidates.flatMap((candidate) => {
      counts[candidate.relationType]++;
      const source = sources.find((s) => s.documentId === candidate.documentId);
      return source ? [{ ...source, ...candidate }] : [];
    });
    return { candidates, queryFailed: false, relationCandidateCounts: counts };
  };
}
