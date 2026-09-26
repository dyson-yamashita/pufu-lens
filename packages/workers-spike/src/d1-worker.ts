import {
  parseGraphActorMergeInput,
  parseGraphDocumentCleanupInput,
  parseGraphMutationEdgeInput,
  parseGraphMutationNodeInput,
  parseGraphPresetId,
  parseGraphProjectMutationInput,
  parseGraphRelationTypes,
} from '@pufu-lens/graph';
import { type D1Binding, record, text } from './d1/binding.js';
import { createD1GraphMutationRepository } from './d1/mutation.js';
import { createD1GraphReadRepository } from './d1/read.js';

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid string array');
  return value.map(text);
}

/** Local-only contract harness. Never deploy this unauthenticated test entrypoint. */
export default {
  async fetch(request: Request, env: { DB: D1Binding }): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/graph')
      return new Response(null, { status: 404 });
    try {
      const payload = record(await request.json());
      const input = record(payload.input);
      const mutation = createD1GraphMutationRepository(env.DB);
      const read = createD1GraphReadRepository(env.DB);
      let result: unknown;
      switch (payload.operation) {
        case 'upsertNode':
          result = await mutation.upsertNode(parseGraphMutationNodeInput(input));
          break;
        case 'upsertEdge':
          result = await mutation.upsertEdge(parseGraphMutationEdgeInput(input));
          break;
        case 'mergeActorGraphNodes':
          result = await mutation.mergeActorGraphNodes(parseGraphActorMergeInput(input));
          break;
        case 'deleteDocumentGraphNodes':
          result = await mutation.deleteDocumentGraphNodes(parseGraphDocumentCleanupInput(input));
          break;
        case 'ensureProjectGraph':
          result = await mutation.ensureProjectGraph(parseGraphProjectMutationInput(input));
          break;
        case 'deleteProjectGraph':
          result = await mutation.deleteProjectGraph(parseGraphProjectMutationInput(input));
          break;
        case 'countDocumentNode':
          result = await read.countDocumentNode({
            projectId: text(input.projectId),
            graphNodeId: text(input.graphNodeId),
          });
          break;
        case 'countRelations':
          result = await read.countRelations({
            projectId: text(input.projectId),
            graphNodeId: text(input.graphNodeId),
            relationTypes: parseGraphRelationTypes(input.relationTypes),
          });
          break;
        case 'findRelatedDocuments': {
          const relationLimits: { MENTIONS?: number; SAME_AS?: number; RELATED_TO?: number } = {};
          if (input.relationLimits !== undefined) {
            for (const [key, value] of Object.entries(record(input.relationLimits))) {
              if (
                !(key === 'MENTIONS' || key === 'SAME_AS' || key === 'RELATED_TO') ||
                typeof value !== 'number'
              )
                throw new Error('Invalid relation limit');
              relationLimits[key] = value;
            }
          }
          result = await read.findRelatedDocuments({
            projectId: text(input.projectId),
            seedDocumentIds: strings(input.seedDocumentIds),
            relationLimits,
          });
          break;
        }
        case 'readPreset':
          result = await read.readPreset({
            projectId: text(input.projectId),
            presetId: parseGraphPresetId(input.presetId),
            documentGraphNodeIds: strings(input.documentGraphNodeIds),
          });
          break;
        default:
          return new Response(null, { status: 404 });
      }
      return Response.json({ result: result ?? null });
    } catch {
      return Response.json({ error: 'Graph operation failed' }, { status: 400 });
    }
  },
};
