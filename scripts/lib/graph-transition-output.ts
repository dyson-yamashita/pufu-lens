import type {
  GraphShadowMismatchCategory,
  GraphShadowObservation,
  GraphShadowOperation,
} from '../../packages/graph/src/shadow.ts';

const GRAPH_TRANSITION_OBSERVATION_EVENT = 'graph_transition_observation';

const CAPABILITIES = new Set<GraphShadowObservation['capability']>(['mutation', 'read']);
const OPERATIONS = new Set<GraphShadowOperation>([
  'count_document_node',
  'count_relations',
  'delete_document_graph_nodes',
  'delete_project_graph',
  'ensure_project_graph',
  'find_related_documents',
  'merge_actor_graph_nodes',
  'read_preset',
  'upsert_edge',
  'upsert_node',
]);
const OUTCOMES = new Set<GraphShadowObservation['outcome']>([
  'match',
  'mismatch',
  'shadow_error',
  'shadow_timeout',
]);
const MISMATCH_CATEGORIES = new Set<GraphShadowMismatchCategory>([
  'candidate_set',
  'count',
  'edge_count',
  'edge_identity',
  'labels',
  'mutation_result',
  'node_count',
  'node_identity',
  'property_keys',
  'relation_counts',
  'status',
  'truncated',
]);

/**
 * Filters child script stdout at the ingest-workflow boundary.
 * Strips every complete single-line `graph_transition_observation` JSON object so
 * result parsing cannot confuse observations with the final script payload, forwards
 * only allowlisted observation fields to the observer, and isolates observer failures
 * from workflow outcome.
 */
export function consumeGraphTransitionOutput(
  stdout: string,
  observer: (observation: GraphShadowObservation) => void,
): string {
  if (!stdout) {
    return stdout;
  }

  const retained: string[] = [];
  const linePattern = /[^\n]*(?:\n|$)/g;

  for (const line of stdout.match(linePattern) ?? []) {
    const content = line.endsWith('\n') ? line.slice(0, -1) : line;
    const trimmed = content.trimStart();

    if (trimmed.startsWith('{')) {
      try {
        const record = JSON.parse(content) as Record<string, unknown>;
        if (
          record &&
          typeof record === 'object' &&
          record.event === GRAPH_TRANSITION_OBSERVATION_EVENT
        ) {
          const sanitized = sanitizeObservation(record);
          if (sanitized) {
            try {
              observer(sanitized);
            } catch {
              // Observer failures must never change workflow outcome.
            }
          }
          continue;
        }
      } catch {
        // Malformed JSON stays in the retained child output.
      }
    }

    retained.push(line);
  }

  return retained.join('');
}

function sanitizeObservation(record: Record<string, unknown>): GraphShadowObservation | null {
  const capability = record.capability;
  const operation = record.operation;
  const outcome = record.outcome;
  const primaryProvider = record.primaryProvider;
  const shadowProvider = record.shadowProvider;
  const mismatchCategories = record.mismatchCategories;
  const primaryLatencyMs = record.primaryLatencyMs;
  const shadowLatencyMs = record.shadowLatencyMs;

  if (
    typeof capability !== 'string' ||
    !CAPABILITIES.has(capability as GraphShadowObservation['capability']) ||
    typeof operation !== 'string' ||
    !OPERATIONS.has(operation as GraphShadowOperation) ||
    typeof outcome !== 'string' ||
    !OUTCOMES.has(outcome as GraphShadowObservation['outcome']) ||
    primaryProvider !== 'postgres_age' ||
    shadowProvider !== 'postgres_relational' ||
    !isValidLatency(primaryLatencyMs) ||
    !isValidLatency(shadowLatencyMs) ||
    !Array.isArray(mismatchCategories)
  ) {
    return null;
  }

  const categories: GraphShadowMismatchCategory[] = [];
  for (const category of mismatchCategories) {
    if (
      typeof category !== 'string' ||
      !MISMATCH_CATEGORIES.has(category as GraphShadowMismatchCategory)
    ) {
      return null;
    }
    categories.push(category as GraphShadowMismatchCategory);
  }

  return {
    capability: capability as GraphShadowObservation['capability'],
    event: GRAPH_TRANSITION_OBSERVATION_EVENT,
    mismatchCategories: [...categories],
    operation: operation as GraphShadowOperation,
    outcome: outcome as GraphShadowObservation['outcome'],
    primaryLatencyMs,
    primaryProvider: 'postgres_age',
    shadowLatencyMs,
    shadowProvider: 'postgres_relational',
  };
}

function isValidLatency(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
