import { isDeepStrictEqual } from 'node:util';
import { rankMetrics } from './keyword-eval.ts';
import {
  type ParityCase,
  parityFixture,
  parityFixtureHash,
  parityMappingHash,
} from './parity-fixture.ts';

export interface ParityRow {
  id: string;
  status: 'ok' | 'error';
  error: string | null;
  chunkIds: string[];
  finalDocumentIds: string[];
  citationDocumentIds: string[];
  tools: string[];
  graph: [string, string, string, string, number][];
  // Explicit observations, not inferred from HTTP status; null means unmeasured and fails gates.
  scopePass: boolean | null;
  mutationPass: boolean | null;
  rubricPass: boolean | null;
  criticalErrors: number;
}
export interface ParityRun {
  metadata: {
    runId: string;
    codeCommit: string;
    profile: 'gcp' | 'cloudflare';
    region: string;
    fixtureVersion: string;
    fixtureHash: string;
    schemaVersion: number;
    mappingHash: string;
    embedding: { mode: 'real' | 'synthetic'; model: string; dimensions: number; metric: string };
  };
  rows: ParityRow[];
}

/** Validates untrusted snapshots before scoring. Missing fields, duplicate cases and unknown IDs throw. */
export function parseParityRun(value: unknown): ParityRun {
  const run = object(value);
  const meta = object(run.metadata);
  const embedding = object(meta.embedding);
  if (meta.profile !== 'gcp' && meta.profile !== 'cloudflare') throw new Error('Invalid profile');
  if (embedding.mode !== 'real' && embedding.mode !== 'synthetic')
    throw new Error('Invalid embedding mode');
  const metadata: ParityRun['metadata'] = {
    runId: label(meta.runId),
    codeCommit: label(meta.codeCommit),
    profile: meta.profile,
    region: label(meta.region),
    fixtureVersion: label(meta.fixtureVersion),
    fixtureHash: label(meta.fixtureHash),
    schemaVersion: integer(meta.schemaVersion),
    mappingHash: label(meta.mappingHash),
    embedding: {
      mode: embedding.mode,
      model: label(embedding.model),
      dimensions: integer(embedding.dimensions),
      metric: label(embedding.metric),
    },
  };
  if (!/^[a-f0-9]{40}$/.test(metadata.codeCommit)) throw new Error('Invalid code commit');
  const rows = array(run.rows).map((input): ParityRow => {
    const row = object(input);
    if (row.status !== 'ok' && row.status !== 'error') throw new Error('Invalid status');
    const error = row.error === null ? null : label(row.error);
    if ((row.status === 'ok') !== (error === null)) throw new Error('Invalid error status');
    const chunkIds = labels(row.chunkIds);
    const finalDocumentIds = labels(row.finalDocumentIds);
    const citationDocumentIds = labels(row.citationDocumentIds);
    if (
      chunkIds.some((id) => !parityFixture.chunks.some((chunk) => chunk.id === id)) ||
      [...finalDocumentIds, ...citationDocumentIds].some(
        (id) => !parityFixture.chunks.some((chunk) => chunk.documentId === id),
      )
    )
      throw new Error('Unknown result ID');
    return {
      id: label(row.id),
      status: row.status,
      error,
      chunkIds,
      finalDocumentIds,
      citationDocumentIds,
      tools: labels(row.tools),
      scopePass: boolean(row.scopePass),
      mutationPass: boolean(row.mutationPass),
      rubricPass: boolean(row.rubricPass),
      criticalErrors: integer(row.criticalErrors),
      graph: array(row.graph).map((input) => {
        const tuple = array(input);
        if (tuple.length !== 5) throw new Error('Invalid graph tuple');
        return [
          label(tuple[0]),
          label(tuple[1]),
          label(tuple[2]),
          label(tuple[3]),
          integer(tuple[4]),
        ];
      }),
    };
  });
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => !parityFixture.cases.some((test) => test.id === row.id))
  )
    throw new Error('Invalid case IDs');
  return { metadata, rows };
}

/** Set overlap at K, normalized by the larger unique set. Empty/empty has no comparison evidence. */
export function parityOverlap(
  left: readonly string[],
  right: readonly string[],
  k: number,
): number | null {
  if (!Number.isSafeInteger(k) || k <= 0) throw new Error('K must be a positive integer');
  const a = [...new Set(left)].slice(0, k);
  const b = [...new Set(right)].slice(0, k);
  const denominator = Math.max(a.length, b.length);
  return denominator ? a.filter((id) => b.includes(id)).length / denominator : null;
}

/** Compares canonical project/node/relation/hop tuples; duplicate output violates the dedupe contract. */
export function graphSetMatches(
  actual: ParityRow['graph'],
  expected: ParityCase['graph'],
): boolean {
  const canonical = (rows: ParityCase['graph']) => rows.map((row) => JSON.stringify(row)).sort();
  const values = canonical(actual);
  return new Set(values).size === values.length && isDeepStrictEqual(values, canonical(expected));
}

/** Requires the versioned real-embedding contract; synthetic lifecycle evidence is never quality evidence. */
function contractMatches(run: ParityRun): boolean {
  const meta = run.metadata;
  return (
    meta.fixtureVersion === parityFixture.version &&
    meta.fixtureHash === parityFixtureHash &&
    meta.schemaVersion === parityFixture.schemaVersion &&
    meta.mappingHash === parityMappingHash &&
    isDeepStrictEqual(meta.embedding, parityFixture.embedding)
  );
}

function documents(row: ParityRow): string[] {
  return [
    ...new Set(
      row.chunkIds.map(
        (id) => parityFixture.chunks.find((chunk) => chunk.id === id)?.documentId ?? '',
      ),
    ),
  ];
}

/** Rejects any scope, required-evidence, failure-status or canonical Graph violation on either backend. */
function hardGate(test: ParityCase, row: ParityRow): boolean {
  const ids = [...documents(row), ...row.finalDocumentIds, ...row.citationDocumentIds];
  const scoped = ids.every((id) =>
    parityFixture.chunks.some(
      (chunk) =>
        chunk.documentId === id &&
        chunk.projectId === test.projectId &&
        !test.forbiddenProjectIds.includes(chunk.projectId),
    ),
  );
  if (
    !scoped ||
    !row.scopePass ||
    !row.mutationPass ||
    row.criticalErrors !== 0 ||
    row.graph.some(
      ([project, source, , target]) =>
        project !== test.projectId ||
        test.forbiddenProjectIds.includes(project) ||
        [source, target].some(
          (id) =>
            !parityFixture.graphNodes.some((node) => node.id === id && node.projectId === project),
        ),
    )
  )
    return false;
  if (test.expectedFailure !== null)
    return (
      row.status === 'error' &&
      row.error === test.expectedFailure &&
      ids.length === 0 &&
      row.graph.length === 0
    );
  if (row.status !== 'ok') return false;
  if (test.kind === 'graph' || test.kind === 'mutation')
    return graphSetMatches(row.graph, test.graph);
  if (test.kind === 'keyword' && Object.keys(test.grades).length === 0 && ids.length !== 0)
    return false;
  const selected =
    test.kind === 'hybrid' || test.kind === 'chat'
      ? row.finalDocumentIds
      : documents(row).slice(0, test.kind === 'keyword' ? 20 : 10);
  return (
    test.required.every((id) => selected.includes(id)) &&
    (test.kind !== 'chat' ||
      (row.rubricPass === true &&
        test.required.every((id) => row.citationDocumentIds.includes(id)) &&
        test.requiredTools.every((tool) => row.tools.includes(tool))))
  );
}

/**
 * Scores local snapshots without IO. Missing baseline/measurements and incompatible contracts never pass.
 * Synthetic vectors cannot establish semantic quality. Report omits query, content and raw provider payloads.
 * Step 7 acceptance remains blocked on performance/cost/remote evidence owned by later steps.
 */
export function evaluateParity(candidateInput: unknown, baselineInput?: unknown) {
  const candidate = parseParityRun(candidateInput);
  const baseline = baselineInput === undefined ? undefined : parseParityRun(baselineInput);
  const contractPass =
    contractMatches(candidate) &&
    candidate.metadata.profile === 'cloudflare' &&
    baseline !== undefined &&
    contractMatches(baseline) &&
    baseline.metadata.profile === 'gcp';
  const cases = parityFixture.cases.map((test) => {
    const row = candidate.rows.find((row) => row.id === test.id);
    const reference = baseline?.rows.find((row) => row.id === test.id);
    const k = test.kind === 'keyword' ? 20 : 10;
    const ranked = row ? documents(row) : [];
    const referenceRanked = reference ? documents(reference) : [];
    const metrics = row
      ? rankMetrics(ranked, test.grades, k)
      : { recall: null, mrr: null, ndcg: null };
    const baselineMetrics = reference ? rankMetrics(referenceRanked, test.grades, k) : null;
    return {
      id: test.id,
      kind: test.kind,
      category: test.category,
      measured: row !== undefined && reference !== undefined,
      hardPass:
        row !== undefined &&
        reference !== undefined &&
        hardGate(test, row) &&
        hardGate(test, reference),
      ...metrics,
      mrrDelta:
        metrics.mrr !== null && baselineMetrics?.mrr != null
          ? metrics.mrr - baselineMetrics.mrr
          : null,
      ndcgDelta:
        metrics.ndcg !== null && baselineMetrics?.ndcg != null
          ? metrics.ndcg - baselineMetrics.ndcg
          : null,
      overlap:
        row && reference
          ? parityOverlap(
              test.kind === 'chat' ? row.finalDocumentIds : ranked,
              test.kind === 'chat' ? reference.finalDocumentIds : referenceRanked,
              test.kind === 'hybrid' ? 5 : 10,
            )
          : null,
      citationOverlap:
        row && reference && test.kind === 'chat'
          ? parityOverlap(row.citationDocumentIds, reference.citationDocumentIds, 10)
          : null,
    };
  });
  const aggregates = (['semantic', 'keyword', 'hybrid', 'chat'] as const).map((kind) => {
    const rows = cases.filter(
      (row) =>
        row.kind === kind &&
        parityFixture.cases.find((test) => test.id === row.id)?.expectedFailure === null,
    );
    const recall = mean(rows.map((row) => row.recall));
    const mrr = mean(rows.map((row) => row.mrr));
    const ndcg = mean(rows.map((row) => row.ndcg));
    const mrrDelta = mean(rows.map((row) => row.mrrDelta));
    const ndcgDelta = mean(rows.map((row) => row.ndcgDelta));
    const overlap = mean(rows.map((row) => row.overlap));
    const categories = [...new Set(rows.map((row) => row.category))].map((category) => ({
      category,
      recall: mean(rows.filter((row) => row.category === category).map((row) => row.recall)),
    }));
    const qualityPass =
      kind === 'semantic'
        ? atLeast(recall, 0.95) &&
          atLeast(mrrDelta, -0.05) &&
          atLeast(ndcgDelta, -0.05) &&
          atLeast(overlap, 0.8)
        : kind === 'keyword'
          ? atLeast(recall, 0.95) &&
            atLeast(mrrDelta, -0.05) &&
            categories.every((row) => row.recall === null || row.recall >= 0.9)
          : kind === 'hybrid'
            ? atLeast(overlap, 0.8) && atLeast(ndcgDelta, -0.05)
            : atLeast(overlap, 0.8);
    return {
      kind,
      recall,
      mrr,
      ndcg,
      mrrDelta,
      ndcgDelta,
      overlap,
      categories,
      pass:
        qualityPass &&
        rows.every((row) => row.hardPass && (kind === 'keyword' || row.overlap !== null)),
    };
  });
  const qualityGate =
    contractPass &&
    cases.every((row) => row.measured && row.hardPass) &&
    aggregates.every((row) => row.pass);
  return {
    reportSchemaVersion: 1,
    candidate: candidate.metadata,
    baseline: baseline?.metadata ?? null,
    contractPass,
    comparisonComplete: cases.every((row) => row.measured),
    qualityGate,
    step7Gate: 'not-evaluated',
    pending: ['remote-evidence', 'performance-absolute-slo', 'cost-budget-decision'],
    aggregates,
    cases,
  };
}

function atLeast(value: number | null, threshold: number) {
  return value !== null && value >= threshold;
}
function mean(values: (number | null)[]) {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid array');
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200)
    throw new Error('Invalid label');
  return value;
}
function labels(value: unknown): string[] {
  const result = array(value).map(label);
  if (new Set(result).size !== result.length) throw new Error('Duplicate value');
  return result;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid integer');
  return value;
}
function boolean(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new Error('Missing observation');
  return value;
}
