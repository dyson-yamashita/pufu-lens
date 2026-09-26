import {
  parseGraphPresetReadResult,
  parseGraphProjectResolverResult,
  parseGraphRelatedDocumentCandidate,
} from '@pufu-lens/graph';
import { validateProjectSlug } from '@pufu-lens/project-tenancy';
import {
  fuseRankedChunkCandidates,
  parseRankedChunkCandidate,
  parseSemanticChunkCandidate,
} from '@pufu-lens/retrieval';

/**
 * Local-only contract probe: validates synthetic provider payloads and runs shared Core policy.
 * This is not an authenticated application API or a provider adapter; never deploy it.
 */
async function fetch(request: Request): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/probe') {
    return new Response('Not found', { status: 404 });
  }
  try {
    const input: unknown = await request.json();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error('Invalid probe payload.');
    }
    const record = input as Record<string, unknown>;
    const project = parseGraphProjectResolverResult(record.project);
    validateProjectSlug(project.projectSlug);
    if (
      !Array.isArray(record.keywordCandidates) ||
      !Array.isArray(record.semanticCandidates) ||
      !Array.isArray(record.graphCandidates)
    ) {
      throw new Error('Invalid candidate arrays.');
    }
    const keywordCandidates = record.keywordCandidates.map(parseRankedChunkCandidate);
    const semanticCandidates = record.semanticCandidates.map(parseSemanticChunkCandidate);
    const graphCandidates = record.graphCandidates.map(parseGraphRelatedDocumentCandidate);
    const graph = parseGraphPresetReadResult(record.graph);
    return Response.json({
      project,
      candidates: fuseRankedChunkCandidates({ keywordCandidates, semanticCandidates, limit: 10 }),
      graphCandidates,
      graph,
    });
  } catch {
    return Response.json({ error: 'Invalid synthetic contract payload' }, { status: 400 });
  }
}

export default { fetch };
