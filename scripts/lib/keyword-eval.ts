import { createHash } from 'node:crypto';
import { type KeywordEvalCase, keywordCorpus } from './keyword-eval-corpus.ts';

export const corpusHash = createHash('sha256').update(JSON.stringify(keywordCorpus)).digest('hex');

export interface KeywordRun {
  readonly schemaVersion: 1;
  readonly corpusHash: string;
  readonly provider: string;
  readonly environment: string;
  readonly cases: readonly {
    readonly id: string;
    readonly status: 'ok' | 'rejected';
    readonly chunkIds: readonly string[];
    readonly latencyMs: readonly number[];
  }[];
}

/** Validates complete snapshots before scoring; unknown, duplicate or incompatible IDs fail closed. */
export function parseKeywordRun(value: unknown): KeywordRun {
  const run = record(value);
  if (run.schemaVersion !== 1 || run.corpusHash !== corpusHash)
    throw new Error('Incompatible keyword snapshot.');
  const provider = label(run.provider);
  const environment = label(run.environment);
  if (!Array.isArray(run.cases) || run.cases.length !== keywordCorpus.cases.length)
    throw new Error('Incomplete keyword snapshot.');
  const seen = new Set<string>();
  const cases = run.cases.map((value: unknown): KeywordRun['cases'][number] => {
    const row = record(value);
    const id = label(row.id);
    if (seen.has(id) || !keywordCorpus.cases.some((test) => test.id === id))
      throw new Error('Invalid case ID.');
    seen.add(id);
    const status = row.status;
    if (status !== 'ok' && status !== 'rejected') throw new Error('Invalid case status.');
    if (!Array.isArray(row.chunkIds) || row.chunkIds.length > keywordCorpus.k)
      throw new Error('Invalid candidate count.');
    const chunkIds = row.chunkIds.map((value: unknown) => label(value));
    if (
      new Set(chunkIds).size !== chunkIds.length ||
      chunkIds.some((id) => !keywordCorpus.chunks.some((chunk) => chunk.id === id))
    )
      throw new Error('Invalid candidate ID.');
    if (status === 'rejected' && chunkIds.length)
      throw new Error('Rejected query returned candidates.');
    if (!Array.isArray(row.latencyMs) || row.latencyMs.length === 0)
      throw new Error('Missing latency samples.');
    const latencyMs = row.latencyMs.map((value: unknown) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error('Invalid latency.');
      return value;
    });
    return { id, status, chunkIds, latencyMs };
  });
  return { schemaVersion: 1, corpusHash, provider, environment, cases };
}

/** Computes document-level Recall@20, truncated MRR and graded nDCG@20; no-relevance cases are excluded. */
export function rankMetrics(
  documents: readonly string[],
  grades: Readonly<Record<string, number>>,
  k = 20,
) {
  const ranked = [...new Set(documents)].slice(0, k);
  const relevant = Object.keys(grades).filter((id) => (grades[id] ?? 0) > 0);
  if (relevant.length === 0) return { recall: null, mrr: null, ndcg: null };
  const first = ranked.findIndex((id) => (grades[id] ?? 0) > 0);
  const dcg = (values: readonly number[]) =>
    values.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  return {
    recall: ranked.filter((id) => (grades[id] ?? 0) > 0).length / relevant.length,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg:
      dcg(ranked.map((id) => grades[id] ?? 0)) /
      dcg(
        Object.values(grades)
          .sort((a, b) => b - a)
          .slice(0, k),
      ),
  };
}

/** Scores fixed judgments and optional PGroonga comparison. Security failures always fail the gate. */
export function evaluateKeywordRun(input: KeywordRun, baseline?: KeywordRun) {
  const run = parseKeywordRun(input);
  const reference = baseline === undefined ? undefined : parseKeywordRun(baseline);
  if (reference && reference.provider !== 'pgroonga')
    throw new Error('Baseline must identify PGroonga.');
  const cases = keywordCorpus.cases.map((test: KeywordEvalCase) => {
    const result = run.cases.find((row) => row.id === test.id);
    if (!result) throw new Error('Missing case.');
    const chunks = result.chunkIds.map((id) => {
      const chunk = keywordCorpus.chunks.find((chunk) => chunk.id === id);
      if (!chunk) throw new Error('Unknown chunk.');
      return chunk;
    });
    const documents = chunks.map((chunk) => chunk.documentId);
    const metrics = rankMetrics(documents, test.grades);
    const expectedStatus = test.reject ? 'rejected' : 'ok';
    const hardPass =
      result.status === expectedStatus &&
      chunks.every((chunk) => chunk.projectId === test.projectId) &&
      new Set(documents).size === documents.length &&
      (Object.keys(test.grades).length > 0 || documents.length === 0) &&
      (test.required ?? []).every((id) => documents.includes(id));
    const referenceRow = reference?.cases.find((row) => row.id === test.id);
    const referenceDocs = referenceRow?.chunkIds.map(
      (id) => keywordCorpus.chunks.find((chunk) => chunk.id === id)?.documentId ?? '',
    );
    const baselineMetrics = referenceDocs ? rankMetrics(referenceDocs, test.grades) : undefined;
    return {
      id: test.id,
      category: test.category,
      ...metrics,
      hardPass,
      documentIds: documents,
      overlap: referenceDocs ? overlap(documents, referenceDocs) : null,
      mrrDelta:
        metrics.mrr !== null && baselineMetrics?.mrr != null
          ? metrics.mrr - baselineMetrics.mrr
          : null,
      ndcgDelta:
        metrics.ndcg !== null && baselineMetrics?.ndcg != null
          ? metrics.ndcg - baselineMetrics.ndcg
          : null,
      p50Ms: percentile(result.latencyMs, 0.5),
      p95Ms: percentile(result.latencyMs, 0.95),
    };
  });
  const categories = [...new Set(cases.map((row) => row.category))].map((category) => {
    const rows = cases.filter((row) => row.category === category);
    return {
      category,
      count: rows.length,
      recall: mean(rows.map((row) => row.recall)),
      hardPass: rows.every((row) => row.hardPass),
    };
  });
  const recall = mean(cases.map((row) => row.recall));
  const mrrDelta = mean(cases.map((row) => row.mrrDelta));
  const qualityPass =
    (recall ?? 0) >= 0.95 &&
    categories.every((row) => row.recall === null || row.recall >= 0.9) &&
    (mrrDelta === null || mrrDelta >= -0.05);
  return {
    schemaVersion: 1,
    corpusVersion: keywordCorpus.version,
    corpusHash,
    provider: run.provider,
    environment: run.environment,
    baselineEnvironment: reference?.environment ?? null,
    gate: qualityPass && cases.every((row) => row.hardPass),
    comparisonComplete: reference !== undefined,
    recall,
    mrr: mean(cases.map((row) => row.mrr)),
    ndcg: mean(cases.map((row) => row.ndcg)),
    mrrDelta,
    p50Ms: percentile(
      run.cases.flatMap((row) => row.latencyMs),
      0.5,
    ),
    p95Ms: percentile(
      run.cases.flatMap((row) => row.latencyMs),
      0.95,
    ),
    categories,
    cases,
  };
}

/** Renders the same machine-readable evaluation as a compact Markdown table without query text. */
export function keywordReportMarkdown(report: ReturnType<typeof evaluateKeywordRun>): string {
  return `# Keyword evaluation\n\nCorpus: ${report.corpusVersion} (${report.corpusHash})\n\nQuality / safety gate: ${report.gate ? 'PASS' : 'FAIL'}; baseline comparison: ${report.comparisonComplete ? 'yes' : 'no'}\n\nRecall@20: ${report.recall}; MRR@20: ${report.mrr}; nDCG@20: ${report.ndcg}\n\n| Case | Recall@20 | MRR@20 | nDCG@20 | Hard gate |\n| --- | --- | --- | --- | --- |\n${report.cases.map((row) => `| ${row.id} | ${row.recall ?? 'n/a'} | ${row.mrr ?? 'n/a'} | ${row.ndcg ?? 'n/a'} | ${row.hardPass ? 'PASS' : 'FAIL'} |`).join('\n')}\n`;
}

function overlap(left: readonly string[], right: readonly string[]): number {
  const denominator = Math.max(left.length, right.length);
  return denominator === 0 ? 1 : left.filter((id) => right.includes(id)).length / denominator;
}

function mean(values: readonly (number | null)[]): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function percentile(values: readonly number[], fraction: number): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid keyword snapshot.');
  return value as Record<string, unknown>;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500)
    throw new Error('Invalid snapshot label.');
  return value;
}
