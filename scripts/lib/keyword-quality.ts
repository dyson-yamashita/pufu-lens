import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import type { ChatToolCall } from '../../apps/web/src/chat.ts';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';
import { qualityCases, qualityDocuments, qualityHybridCases } from './keyword-quality-corpus.ts';
import { verifyQualityWorkflowHttp } from './keyword-quality-http.ts';

export const qualityCorpusHash = createHash('sha256')
  .update(JSON.stringify({ qualityCases, qualityDocuments, qualityHybridCases }))
  .digest('hex');
const uuid = (n: number) => `76700000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const projectId = uuid(1);
const otherProjectId = uuid(2);
interface HybridResult {
  provider: string;
  id: string;
  actual: string[];
  final: string[];
  requiredMissing: string[];
  finalMissing: string[];
  ndcg: number | null;
  toolCalls: readonly ChatToolCall[];
}
const documentId = (id: string) => {
  const index = qualityDocuments.findIndex(([key]) => key === id);
  assert.ok(index >= 0, `Unknown fixture document: ${id}`);
  return uuid(100 + index);
};
const documentKey = (id: string) => {
  const doc = qualityDocuments.find(([key]) => documentId(key) === id);
  assert.ok(doc, 'Unexpected or cross-project candidate');
  return doc[0];
};
const missing = (expected: readonly string[], actual: readonly string[]) =>
  expected.filter((id) => !actual.includes(id));
const overlap = (a: readonly string[], b: readonly string[]) =>
  a.length || b.length ? a.filter((id) => b.includes(id)).length / Math.max(a.length, b.length) : 1;

/** Computes binary judged metrics without excluding zero-hit positive or false-positive negative cases. */
export function qualityMetrics(expected: readonly string[], actual: readonly string[]) {
  const absent = missing(expected, actual);
  const extra = missing(actual, expected);
  const first = actual.findIndex((id) => expected.includes(id));
  const dcg = actual.reduce(
    (sum, id, index) => sum + (expected.includes(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const ideal = expected.reduce((sum, _, index) => sum + 1 / Math.log2(index + 2), 0);
  return {
    missing: absent,
    extra,
    recall: expected.length ? 1 - absent.length / expected.length : null,
    mrr: expected.length ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    ndcg: ideal ? dcg / ideal : null,
    exact: absent.length === 0 && extra.length === 0,
  };
}

/** Summarizes judged positive queries separately from exact-set and negative-query failures. */
export function summarizeKeywordQuality(
  rows: readonly (ReturnType<typeof qualityMetrics> & { provider: string; category: string })[],
) {
  return ['pgroonga-primary', 'portable-primary'].map((provider) => {
    const selected = rows.filter((row) => row.provider === provider);
    const metrics = (values: typeof selected) => {
      const positive = values.filter((row) => row.recall !== null);
      const mean = (key: 'recall' | 'mrr' | 'ndcg') =>
        positive.length
          ? positive.reduce((sum, row) => sum + (row[key] ?? 0), 0) / positive.length
          : null;
      return {
        count: values.length,
        exactFailures: values.filter((row) => !row.exact).length,
        negativeFailures: values.filter((row) => row.recall === null && row.extra.length > 0)
          .length,
        recall: mean('recall'),
        mrr: mean('mrr'),
        ndcg: mean('ndcg'),
      };
    };
    return {
      provider,
      ...metrics(selected),
      categories: [...new Set(selected.map((row) => row.category))].map((category) => ({
        category,
        ...metrics(selected.filter((row) => row.category === category)),
      })),
    };
  });
}

/**
 * Evaluates real PGroonga/portable SQL and the real Chat hybrid facade on a dedicated local synthetic DB.
 * Inserts collision-protected fixture projects and deletes only successfully created projects on exit.
 * Semantic ranks and embeddings are controlled test inputs; no external model or production data is used.
 */
export async function collectKeywordQuality(databaseUrl: string) {
  validateKeywordEvalUrl(databaseUrl);
  const { createPostgresChatRepository, privateChatSourcesForResponse } = await import(
    '../../apps/web/src/chat.ts'
  );
  const { createGcpPostgresCandidateRepositories } = await import(
    '../../apps/web/src/postgres-chat-candidate-adapters.ts'
  );
  const { runPrivateChatDetailStep, runPrivateChatPreparingStep, runPrivateChatRetrievingStep } =
    await import('../../apps/web/src/private-chat-search.ts');
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  let created = false;
  try {
    await sql`INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix) VALUES
      (${projectId}, 'keyword-767-quality', 'Synthetic quality', 'graph_keyword_767_quality', 'keyword-767-quality'),
      (${otherProjectId}, 'keyword-767-other', 'Synthetic isolation', 'graph_keyword_767_other', 'keyword-767-other')`;
    created = true;
    for (const [index, [key, content]] of qualityDocuments.entries()) {
      const id = documentId(key);
      await sql`INSERT INTO public.raw_documents
        (id, project_id, source_type, source_id, logical_source_id, source_version, storage_uri, content_hash)
        VALUES (${id}, ${projectId}, 'web', ${key}, ${key}, 'v1', 'synthetic://quality', ${key})`;
      await sql`INSERT INTO public.documents
        (id, project_id, raw_document_id, doc_type, logical_source_id, graph_node_id, title, canonical_uri)
        VALUES (${id}, ${projectId}, ${id}, 'web_page', ${key}, ${key}, ${key}, ${`https://example.test/${key}`})`;
      await sql`INSERT INTO public.document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
        VALUES (${id}, ${projectId}, ${id}, 0, ${content}, ${key})`;
      // A second chunk verifies document deduplication without changing document relevance.
      if (index === 4)
        await sql`INSERT INTO public.document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
        VALUES (${uuid(900)}, ${projectId}, ${id}, 1, ${content}, 'duplicate')`;
    }
    const foreignId = uuid(999);
    await sql`INSERT INTO public.raw_documents
      (id, project_id, source_type, source_id, logical_source_id, source_version, storage_uri, content_hash)
      VALUES (${foreignId}, ${otherProjectId}, 'web', 'foreign', 'foreign', 'v1', 'synthetic://quality', 'foreign')`;
    await sql`INSERT INTO public.documents (id, project_id, raw_document_id, doc_type, logical_source_id, graph_node_id)
      VALUES (${foreignId}, ${otherProjectId}, ${foreignId}, 'web_page', 'foreign', 'foreign')`;
    await sql`INSERT INTO public.document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
      VALUES (${foreignId}, ${otherProjectId}, ${foreignId}, 0, 'invoice 31415 ActivityPub 黒猫 ＡＰＩ', 'foreign')`;
    // Like the v1 collector, prefer indexed search for repeatable PGroonga score/token semantics.
    // This connection belongs only to this collector and is closed below; no shared pool is changed.
    await sql`ANALYZE public.document_chunks`;
    await sql`SET enable_seqscan = off`;

    const keyword = [];
    const hybrid: HybridResult[] = [];
    for (const mode of ['pgroonga-primary', 'portable-primary'] as const) {
      const observations: unknown[] = [];
      const candidates = createGcpPostgresCandidateRepositories(sql, {
        keywordTransitionMode: mode,
        keywordObserver: (event) => {
          observations.push(event);
        },
      });
      for (const c of qualityCases) {
        const rows = await candidates.keywordCandidateRepository.search({
          normalizedQuery: c.query,
          projectId,
          limit: 20,
        });
        const actual = rows.map((row, index) => {
          assert.equal(row.rank, index + 1);
          return documentKey(row.documentId);
        });
        assert.equal(new Set(actual).size, actual.length);
        keyword.push({
          provider: mode,
          id: c.id,
          category: c.category,
          actual,
          ...qualityMetrics(c.relevant, actual),
        });
      }
      for (const c of qualityHybridCases) {
        const queryCase = qualityCases.find(({ id }) => id === c.queryId);
        assert.ok(queryCase);
        const semanticCandidates = c.semantic.map((key, index) => {
          const content = qualityDocuments.find(([id]) => id === key)?.[1];
          assert.ok(content);
          return {
            documentId: documentId(key),
            chunkId: documentId(key),
            chunkIndex: 0,
            rawDocumentId: documentId(key),
            title: key,
            canonicalUri: `https://example.test/${key}`,
            docType: 'web_page',
            snippet: content,
            rank: index + 1,
            cosineDistance: 0.1 + index * 0.01,
          };
        });
        const repository = createPostgresChatRepository(sql, {
          candidateRepositories: {
            ...candidates,
            semanticCandidateRepository: {
              async search(input) {
                assert.equal(input.projectId, projectId);
                return semanticCandidates.slice(0, input.limit);
              },
            },
          },
        });
        const sources = await repository.hybridSearch({
          projectId,
          query: queryCase.query,
          embedding: [1],
          embeddingModel: 'controlled-quality',
          limit: 10,
        });
        const prepared = runPrivateChatPreparingStep({
          graphName: null,
          projectId,
          question: queryCase.query,
          nowIso: '2026-09-24T00:00:00Z',
          hybridSearchDocumentLimit: 5,
        });
        const retrieved = await runPrivateChatRetrievingStep(prepared, repository, {
          model: 'controlled-quality',
          dimensions: 1536,
          async embedTexts() {
            return [Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))];
          },
        });
        const final = await runPrivateChatDetailStep(retrieved, repository);
        const responseSources = privateChatSourcesForResponse(final.sources);
        assert.doesNotMatch(
          JSON.stringify(responseSources),
          /chunkId|chunkIndex|fusedScore|vectorDistance|keywordRank|semanticRank/,
        );
        await verifyQualityWorkflowHttp({
          projectId,
          question: queryCase.query,
          response: {
            answer: '合成HTTP検証（回答品質は未評価）',
            projectSlug: 'keyword-767-quality',
            status: 'answered',
            sources: responseSources,
            toolCalls: final.toolCalls,
          },
        });
        hybrid.push({
          provider: mode,
          id: c.id,
          actual: sources.slice(0, 5).map((s) => documentKey(s.documentId)),
          final: responseSources.map((s) => documentKey(s.documentId)),
          requiredMissing: missing(
            c.required,
            sources.slice(0, 5).map((s) => documentKey(s.documentId)),
          ),
          finalMissing: missing(
            c.required,
            responseSources.map((s) => documentKey(s.documentId)),
          ),
          ndcg: qualityMetrics(
            queryCase.relevant,
            sources.map((s) => documentKey(s.documentId)),
          ).ndcg,
          toolCalls: final.toolCalls,
        });
      }
      if (mode === 'portable-primary') {
        assert.equal(observations.length, qualityCases.length + qualityHybridCases.length * 2);
        for (const event of observations) {
          assert.ok(event && typeof event === 'object' && 'outcome' in event);
          assert.equal(event.outcome, 'success', 'No fallback may mask candidate quality');
        }
      }
    }
    const comparisons = qualityHybridCases.map(({ id }) => {
      const baseline = hybrid.find((row) => row.id === id && row.provider === 'pgroonga-primary');
      const candidate = hybrid.find((row) => row.id === id && row.provider === 'portable-primary');
      assert.ok(baseline && candidate);
      const top5Overlap = overlap(baseline.actual, candidate.actual);
      const finalOverlap = overlap(baseline.final, candidate.final);
      const ndcgDelta = (candidate.ndcg ?? 0) - (baseline.ndcg ?? 0);
      return {
        id,
        top5Overlap,
        finalOverlap,
        ndcgDelta,
        gate:
          top5Overlap >= 0.8 &&
          finalOverlap >= 0.8 &&
          ndcgDelta >= -0.05 &&
          candidate.requiredMissing.length === 0 &&
          candidate.finalMissing.length === 0,
      };
    });
    return {
      schemaVersion: 1,
      planner: 'index-preferred; enable_seqscan=off; synthetic-only',
      corpusHash: qualityCorpusHash,
      summary: summarizeKeywordQuality(keyword),
      http: {
        protocolRoundTrips: hybrid.length,
        nextRouteAndAuth: 'not-evaluated',
        synthesis: 'stub',
        semantic: 'controlled-ranks',
      },
      keyword,
      hybrid,
      comparisons,
      keywordExactGate: keyword
        .filter((r) => r.provider === 'portable-primary')
        .every((r) => r.exact),
      hybridGate: comparisons.every((r) => r.gate),
    };
  } finally {
    try {
      if (created)
        await sql`DELETE FROM public.projects WHERE id IN (${projectId}, ${otherProjectId})`;
    } finally {
      await sql.end();
    }
  }
}
