import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { backfillKeywords, parseKeywordBackfillOptions } from './keyword-backfill.ts';
import {
  corpusHash,
  evaluateKeywordRun,
  type KeywordRun,
  parseKeywordRun,
} from './keyword-eval.ts';
import { keywordCorpus } from './keyword-eval-corpus.ts';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';
import { keywordHoldoutCases } from './keyword-holdout.ts';

const url = process.env.KEYWORD_EVAL_DATABASE_URL;
const uuid = (n: number) => `75200000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const alpha = uuid(1);
const beta = uuid(2);
const gamma = uuid(3);

test('selected adapter and materialization/backfill on synthetic migrated DB', {
  skip: !url,
}, async (t) => {
  assert.ok(url);
  validateKeywordEvalUrl(url);
  const { createGcpPostgresCandidateRepositories } = await import(
    '../../apps/web/src/postgres-chat-candidate-adapters.ts'
  );
  const { createPostgresPortableKeywordCandidateRepository } = await import(
    '../../apps/web/src/postgres-portable-keyword-adapter.ts'
  );
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const createdProjects: string[] = [];
  const repository = createPostgresPortableKeywordCandidateRepository(sql);
  const search = (query: string, projectId = alpha, limit = 20) =>
    repository.search({ normalizedQuery: query, projectId, limit });
  const options = (...args: string[]) => parseKeywordBackfillOptions(['--project', alpha, ...args]);
  const documents = [...new Set(keywordCorpus.chunks.map((c) => c.documentId))];
  const documentId = (id: string) => uuid(100 + documents.indexOf(id));
  const chunkId = (id: string) => uuid(1000 + keywordCorpus.chunks.findIndex((c) => c.id === id));
  try {
    // Refuse collisions rather than deleting unrelated data.
    await sql`INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix) VALUES
      (${alpha}, 'keyword-752-alpha', 'Synthetic alpha', 'graph_keyword_752_alpha', 'keyword-752-alpha'),
      (${beta}, 'keyword-752-beta', 'Synthetic beta', 'graph_keyword_752_beta', 'keyword-752-beta')`;
    createdProjects.push(alpha, beta);
    for (const id of documents) {
      const chunk = keywordCorpus.chunks.find((c) => c.documentId === id);
      assert.ok(chunk);
      const projectId = chunk.projectId === 'alpha' ? alpha : beta;
      await sql`INSERT INTO public.raw_documents
        (id, project_id, source_type, source_id, logical_source_id, source_version, storage_uri, content_hash)
        VALUES (${documentId(id)}, ${projectId}, 'web', ${id}, ${id}, 'v1', 'synthetic://keyword', ${id})`;
      await sql`INSERT INTO public.documents
        (id, project_id, raw_document_id, doc_type, logical_source_id, graph_node_id, title)
        VALUES (${documentId(id)}, ${projectId}, ${documentId(id)}, 'web_page', ${id}, ${id}, ${id})`;
    }
    for (const [i, chunk] of keywordCorpus.chunks.entries()) {
      await sql`INSERT INTO public.document_chunks
        (id, project_id, document_id, chunk_index, content, content_hash)
        VALUES (${chunkId(chunk.id)}, ${chunk.projectId === 'alpha' ? alpha : beta},
          ${documentId(chunk.documentId)}, ${i}, ${chunk.content}, ${chunk.id})`;
    }
    await t.test(
      'fixed v1 judgments, mandatory baseline, provenance and one-based ranks',
      async () => {
        const cases: KeywordRun['cases'][number][] = [];
        for (const c of keywordCorpus.cases) {
          if (c.reject) {
            await assert.rejects(search(c.query));
            cases.push({ id: c.id, status: 'rejected', chunkIds: [], latencyMs: [0] });
            continue;
          }
          const start = performance.now();
          const rows = await search(c.query, c.projectId === 'alpha' ? alpha : beta);
          const latency = performance.now() - start;
          for (const [index, row] of rows.entries()) {
            const source = keywordCorpus.chunks.find((chunk) => chunkId(chunk.id) === row.chunkId);
            assert.ok(source);
            assert.equal(row.documentId, documentId(source.documentId));
            assert.equal(row.rawDocumentId, documentId(source.documentId));
            assert.equal(row.snippet, source.content.slice(0, 700));
            assert.equal(row.rank, index + 1);
            assert.equal('score' in row, false);
          }
          cases.push({
            id: c.id,
            status: 'ok',
            chunkIds: rows.map((r) => {
              const source = keywordCorpus.chunks.find((chunk) => chunkId(chunk.id) === r.chunkId);
              assert.ok(source);
              return source.id;
            }),
            latencyMs: [latency],
          });
        }
        const baseline = parseKeywordRun(
          JSON.parse(
            await readFile(
              new URL('../../fixtures/keyword/pgroonga-baseline-v1.json', import.meta.url),
              'utf8',
            ),
          ),
        );
        const result = evaluateKeywordRun(
          {
            schemaVersion: 1,
            corpusHash,
            provider: 'selected-gist',
            environment: 'local synthetic',
            cases,
          },
          baseline,
        );
        assert.equal(result.gate, true, JSON.stringify(result));
        assert.equal(result.comparisonComplete, true);
        assert.equal(result.recall, 1);
        // Deployment factory remains PGroonga: its known typo residual is unchanged.
        const primary = createGcpPostgresCandidateRepositories(sql).keywordCandidateRepository;
        assert.equal(
          (await primary.search({ projectId: alpha, normalizedQuery: 'NebulaNtoe', limit: 20 }))
            .length,
          0,
        );
      },
    );
    await t.test(
      'shadow mode preserves PGroonga primary and emits sanitized comparison only',
      async () => {
        const observations: unknown[] = [];
        const primary = createGcpPostgresCandidateRepositories(sql).keywordCandidateRepository;
        const shadow = createGcpPostgresCandidateRepositories(sql, {
          keywordObserver: (observation) => {
            observations.push(observation);
          },
          keywordTransitionMode: 'pgroonga-shadow',
        }).keywordCandidateRepository;
        const input = { limit: 20, normalizedQuery: 'NebulaNtoe', projectId: alpha };
        const [primaryRows, shadowRows, portableRows] = await Promise.all([
          primary.search(input),
          shadow.search(input),
          repository.search(input),
        ]);
        assert.deepEqual(shadowRows, primaryRows);
        assert.ok(observations.length > 0);
        assert.doesNotMatch(JSON.stringify(observations), /NebulaNtoe|Synthetic|content|score/);
        const observation = observations.at(-1) as Record<string, unknown> | undefined;
        assert.equal(observation?.event, 'keyword_transition_observation');
        assert.equal(observation?.primaryProvider, 'pgroonga');
        assert.equal(observation?.shadowProvider, 'portable');
        assert.equal(observation?.primaryCandidateCount, primaryRows.length);
        assert.equal(observation?.shadowCandidateCount, portableRows.length);
      },
    );
    await t.test('normalization matches spike for Unicode and whitespace edge cases', async () => {
      for (const input of [
        ' ＡＢＣ ',
        'カ\u3099',
        'e\u0301',
        'İ ΟΣ',
        '① ㍿ ﬃ',
        '🧑‍💻',
        '\uFEFF\tA\n\u3000',
        'A\u0085',
      ]) {
        const rows = await sql`SELECT public.normalize_keyword(${input}) AS value`;
        assert.equal(rows[0]?.value, input.normalize('NFKC').toLowerCase().trim());
      }
      await assert.rejects(search('a'.repeat(1001)));
      await assert.rejects(search('\u0000'));
      await assert.rejects(search('test', alpha, 0));
      assert.deepEqual(await search(' \t\uFEFF'), []);
    });
    await t.test('threshold and timeout are local on success and SQL failure', async () => {
      await sql`SET pg_trgm.word_similarity_threshold = 0.99`;
      await sql`SET statement_timeout = '17s'`;
      assert.ok((await search('NebulaNtoe')).length > 0);
      await assert.rejects(search('query', 'invalid-uuid'));
      assert.equal(
        (await sql`SELECT current_setting('pg_trgm.word_similarity_threshold') AS value`)[0]?.value,
        '0.99',
      );
      assert.equal((await sql`SHOW statement_timeout`)[0]?.statement_timeout, '17s');
    });
    await t.test('short-query timeout aborts and restores pooled session settings', async () => {
      const locker = postgres(url, { max: 1, onnotice: () => {} });
      const session = await locker.reserve();
      try {
        await session`BEGIN`;
        await session`LOCK TABLE public.document_chunks IN ACCESS EXCLUSIVE MODE`;
        await assert.rejects(
          search('猫'),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === '57014',
        );
        assert.equal((await sql`SHOW statement_timeout`)[0]?.statement_timeout, '17s');
        assert.equal(
          (await sql`SELECT current_setting('pg_trgm.word_similarity_threshold') AS value`)[0]
            ?.value,
          '0.99',
        );
      } finally {
        await session`ROLLBACK`;
        session.release();
        await locker.end();
      }
    });
    await t.test(
      'rejects inconsistent chunk/document project before applying candidate limit',
      async () => {
        const id = uuid(4000);
        await sql`INSERT INTO public.document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
        VALUES (${id}, ${alpha}, ${documentId('d13')}, 99, 'isolatedneedle', 'invalid-project-pair')`;
        assert.deepEqual(await search('isolatedneedle'), []);
        await sql`DELETE FROM public.document_chunks WHERE id = ${id}`;
      },
    );
    await t.test(
      'dry-run, range, resume, retries, NULL legacy rows and project isolation',
      async () => {
        // Emulate pre-migration rows, only within a rollback-safe synthetic transaction.
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE public.document_chunks DISABLE TRIGGER document_chunks_materialize_keyword`;
          await tx`UPDATE public.document_chunks SET keyword_content = NULL WHERE project_id IN (${alpha}, ${beta})`;
          await tx`ALTER TABLE public.document_chunks ENABLE TRIGGER document_chunks_materialize_keyword`;
        });
        const before = await backfillKeywords(sql, options('--status'));
        assert.equal(before.pending, '36');
        // Inject a mid-batch row failure, then retry after removing only this synthetic guard.
        await sql`ALTER TABLE public.document_chunks ADD CONSTRAINT keyword_test_abort_batch
          CHECK (content_hash <> 'c12' OR keyword_content IS NULL) NOT VALID`;
        try {
          await assert.rejects(
            backfillKeywords(sql, options('--execute', '--limit', '1000')),
            (error: unknown) => error instanceof Error && 'code' in error && error.code === '23514',
          );
          assert.equal((await backfillKeywords(sql, options('--status'))).pending, before.pending);
        } finally {
          await sql`ALTER TABLE public.document_chunks DROP CONSTRAINT keyword_test_abort_batch`;
        }
        const dry = await backfillKeywords(sql, options('--dry-run', '--limit', '2'));
        assert.equal(dry.updated, 0);
        assert.equal(dry.selected, 2);
        assert.equal(dry.resumeCursor, null);
        assert.equal(dry.pending, before.pending);
        const rangeArgs = [
          '--document-from',
          documentId('d01'),
          '--document-through',
          documentId('d01'),
        ];
        const first = await backfillKeywords(
          sql,
          options('--execute', '--limit', '1', ...rangeArgs),
        );
        assert.equal(first.updated, 1);
        assert.ok(first.resumeCursor);
        assert.throws(() => options('--execute', '--resume-cursor', first.resumeCursor ?? ''));
        const nextOptions = options(
          '--execute',
          '--limit',
          '1',
          ...rangeArgs,
          '--resume-cursor',
          first.resumeCursor,
        );
        const next = await backfillKeywords(sql, nextOptions);
        assert.equal(next.updated, 1);
        assert.equal(next.pending, '0');
        assert.equal((await backfillKeywords(sql, nextOptions)).updated, 0);
        assert.equal((await backfillKeywords(sql, options('--execute', ...rangeArgs))).updated, 0);
        const rest = await backfillKeywords(sql, options('--execute', '--limit', '1000'));
        assert.equal(rest.updated, 34);
        assert.equal(rest.pending, '0');
        assert.equal(
          (
            await sql`SELECT count(*)::int AS n FROM public.document_chunks WHERE project_id = ${beta} AND keyword_content IS NULL`
          )[0]?.n,
          1,
        );
        assert.equal((await backfillKeywords(sql, options('--execute'))).updated, 0);
      },
    );
    await t.test('backfill and concurrent content update cannot leave stale text', async () => {
      const id = chunkId('c01');
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE public.document_chunks DISABLE TRIGGER document_chunks_materialize_keyword`;
        await tx`UPDATE public.document_chunks SET keyword_content = NULL WHERE id = ${id}`;
        await tx`ALTER TABLE public.document_chunks ENABLE TRIGGER document_chunks_materialize_keyword`;
      });
      const writer = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await Promise.all([
          backfillKeywords(sql, options('--execute')),
          writer`UPDATE public.document_chunks SET content = 'concurrentneedle' WHERE id = ${id}`,
        ]);
        assert.equal(
          (await sql`SELECT keyword_content FROM public.document_chunks WHERE id = ${id}`)[0]
            ?.keyword_content,
          'concurrentneedle',
        );
        assert.equal((await backfillKeywords(sql, options('--status'))).pending, '0');
      } finally {
        await writer.end();
      }
    });
    await t.test(
      'update rollback, direct tampering and delete/reinsert use current content atomically',
      async () => {
        const id = chunkId('c01');
        await sql`UPDATE public.document_chunks SET content = 'ＺＥＢＲＡ 更新' WHERE id = ${id}`;
        assert.equal((await search('zebra'))[0]?.chunkId, id);
        await sql`UPDATE public.document_chunks SET keyword_content = 'stale' WHERE id = ${id}`;
        assert.equal(
          (await sql`SELECT keyword_content FROM public.document_chunks WHERE id = ${id}`)[0]
            ?.keyword_content,
          'zebra 更新',
        );
        await assert.rejects(
          sql.begin(async (tx) => {
            await tx`UPDATE public.document_chunks SET content = 'rollbackneedle' WHERE id = ${id}`;
            throw new Error('rollback');
          }),
        );
        assert.equal((await search('rollbackneedle')).length, 0);
        await sql.begin(async (tx) => {
          await tx`DELETE FROM public.document_chunks WHERE id = ${id}`;
          await tx`INSERT INTO public.document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
          VALUES (${id}, ${alpha}, ${documentId('d01')}, 0, 'replacementneedle', 'replacement')`;
        });
        assert.equal((await search('zebra')).length, 0);
        assert.equal((await search('replacementneedle'))[0]?.chunkId, id);
        await sql`DELETE FROM public.documents WHERE id = ${documentId('d01')}`;
        assert.equal((await search('replacementneedle')).length, 0);
      },
    );
    await t.test(
      'holdout short queries, combining marks, emoji and literal metacharacters',
      async () => {
        await sql`INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix)
        VALUES (${gamma}, 'keyword-752-holdout', 'Synthetic holdout', 'graph_keyword_752_holdout', 'keyword-752-holdout')`;
        createdProjects.push(gamma);
        const texts = [
          '黒猫の記録。',
          'カ\u3099ラスとcafe\u0301 🧑‍💻',
          'rate 50% x_y C:\\tmp',
          'invoice 31415',
          'invoice 31416',
          '① ＡＰＩ ﬃ',
        ];
        for (const [i, content] of texts.entries()) {
          const id = uuid(2000 + i);
          await sql`INSERT INTO public.raw_documents
          (id, project_id, source_type, source_id, logical_source_id, source_version, storage_uri, content_hash)
          VALUES (${id}, ${gamma}, 'web', ${id}, ${id}, 'v1', 'synthetic://holdout', ${id})`;
          await sql`INSERT INTO public.documents
          (id, project_id, raw_document_id, doc_type, logical_source_id, graph_node_id)
          VALUES (${id}, ${gamma}, ${id}, 'web_page', ${id}, ${id})`;
          await sql`INSERT INTO public.document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
          VALUES (${id}, ${gamma}, ${id}, 0, ${content}, ${id})`;
        }
        for (const [query, expected] of [
          ['猫', 0],
          ['黒猫', 0],
          ['ガラス', 1],
          ['café', 1],
          ['🧑‍💻', 1],
          ['%', 2],
          ['_', 2],
          ['\\', 2],
          ['1 api ffi', 5],
        ] as const) {
          const rows = await search(query, gamma);
          assert.equal(rows[0]?.chunkId, uuid(2000 + expected), query);
        }
        const primary = createGcpPostgresCandidateRepositories(sql).keywordCandidateRepository;
        const holdoutResults = await Promise.all(
          keywordHoldoutCases.map(async (holdoutCase) => {
            const [baselineRows, portableRows] = await Promise.all([
              primary.search({ limit: 20, normalizedQuery: holdoutCase.query, projectId: gamma }),
              search(holdoutCase.query, gamma),
            ]);
            const expectedIds = new Set(
              holdoutCase.expectedChunkIndexes.map((index) => uuid(2000 + index)),
            );
            const matchesExpected = (rows: readonly { readonly chunkId: string }[]) =>
              holdoutCase.expectedChunkIndexes.length === 0
                ? rows.length === 0
                : rows[0]?.chunkId !== undefined && expectedIds.has(rows[0].chunkId);
            return {
              baselineMatches: matchesExpected(baselineRows),
              candidateMatches: matchesExpected(portableRows),
              id: holdoutCase.id,
              knownFailure: holdoutCase.knownFailure,
              baselineCount: baselineRows.length,
              candidateCount: portableRows.length,
            };
          }),
        );
        const baselineFailures = holdoutResults.filter((result) => !result.baselineMatches);
        const candidateFailures = holdoutResults.filter((result) => !result.candidateMatches);
        t.diagnostic(
          `Step 3D holdout baseline failures=${baselineFailures.length}, candidate failures=${candidateFailures.length}, cases=${holdoutResults.length}`,
        );
        const numericFailure = holdoutResults.find(
          (result) => result.knownFailure === 'portable_numeric_false_positive',
        );
        assert.ok(numericFailure && numericFailure.candidateCount > 0);
        assert.ok(
          candidateFailures.some(
            (result) => result.knownFailure === 'portable_numeric_false_positive',
          ),
          'known numeric false positive must remain visible in the holdout gate',
        );
        assert.deepEqual(await search('absent OR blackhole', gamma), []);
        assert.deepEqual(await search("' OR 1=1 --", gamma), []);
        // Preserve and expose a known fuzzy false positive, rather than relax judgments or threshold.
        const numericFalsePositives = await search('31417', gamma);
        assert.ok(numericFalsePositives.length > 0);
        t.diagnostic(
          `holdout numeric no-relevance query: ${numericFalsePositives.length} false positives; rollout gate remains open`,
        );
        assert.deepEqual(await search('黒猫', beta), []);
        await sql`DELETE FROM public.projects WHERE id = ${gamma}`;
        assert.deepEqual(await search('猫', gamma), []);
      },
    );
  } finally {
    try {
      if (createdProjects.length)
        await sql`DELETE FROM public.projects WHERE id = ANY(${sql.array(createdProjects)}::uuid[])`;
    } finally {
      await sql.end();
    }
  }
});
