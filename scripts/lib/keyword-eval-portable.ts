import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { corpusHash, type KeywordRun } from './keyword-eval.ts';
import { keywordCorpus } from './keyword-eval-corpus.ts';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';
import {
  keywordNgrams,
  normalizeKeyword,
  portableProviders,
  portableQuery,
} from './keyword-eval-portable-query.ts';

/** Measures each candidate in its own transaction/schema using only the fixed synthetic corpus.
 * Requires preinstalled pg_trgm; refuses existing schema, rolls back errors, never touches app tables.
 * Latency includes query normalization and roundtrip; diagnostics are synthetic-only EXPLAIN rows.
 */
export async function collectPortableKeywords(databaseUrl: string) {
  validateKeywordEvalUrl(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const results = [];
    for (const provider of portableProviders) {
      results.push(
        await sql.begin(async (tx) => {
          await tx`SET LOCAL statement_timeout = '10s'`;
          await tx`SET LOCAL pg_trgm.similarity_threshold = 0.3`;
          await tx`SET LOCAL pg_trgm.word_similarity_threshold = 0.6`;
          const versions: readonly unknown[] =
            await tx`SELECT current_setting('server_version') AS postgres, extversion AS trgm FROM pg_extension WHERE extname = 'pg_trgm'`;
          const version = versions[0];
          if (
            !version ||
            typeof version !== 'object' ||
            !('postgres' in version) ||
            !('trgm' in version) ||
            typeof version.postgres !== 'string' ||
            typeof version.trgm !== 'string'
          )
            throw new Error('pg_trgm must be preinstalled.');
          await tx`CREATE SCHEMA keyword_eval_portable`;
          await tx`CREATE TABLE keyword_eval_portable.chunks (id text PRIMARY KEY, document_id text NOT NULL, project_id text NOT NULL, content text NOT NULL)`;
          const usesGrams = provider.startsWith('bigram') || provider.startsWith('trigram');
          if (usesGrams)
            await tx`CREATE TABLE keyword_eval_portable.tokens (chunk_id text NOT NULL REFERENCES keyword_eval_portable.chunks(id), token text NOT NULL, PRIMARY KEY(token, chunk_id))`;
          if (provider === 'fts-simple')
            await tx`ALTER TABLE keyword_eval_portable.chunks ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED`;
          const started = performance.now();
          const chunks = keywordCorpus.chunks.map((c) => ({
            id: c.id,
            document_id: c.documentId,
            project_id: c.projectId,
            content: normalizeKeyword(c.content),
          }));
          const tokens = usesGrams
            ? chunks.flatMap((c) =>
                keywordNgrams(c.content, provider.startsWith('trigram') ? 3 : 2).map((token) => ({
                  chunk_id: c.id,
                  token,
                })),
              )
            : [];
          await tx`INSERT INTO keyword_eval_portable.chunks ${tx(chunks)}`;
          if (tokens.length) await tx`INSERT INTO keyword_eval_portable.tokens ${tx(tokens)}`;
          const loadMs = performance.now() - started;
          const buildStart = performance.now();
          await tx`CREATE INDEX ON keyword_eval_portable.chunks(project_id)`;
          if (provider === 'fts-simple')
            await tx`CREATE INDEX ON keyword_eval_portable.chunks USING gin(search)`;
          if (provider.startsWith('trgm-') || provider === 'bigram-word') {
            if (provider.endsWith('-gist'))
              await tx`CREATE INDEX ON keyword_eval_portable.chunks USING gist(content gist_trgm_ops)`;
            else
              await tx`CREATE INDEX ON keyword_eval_portable.chunks USING gin(content gin_trgm_ops)`;
          }
          const buildMs = performance.now() - buildStart;
          const writeMs = [];
          // Full-content rewrites, including token replacement, mimic reingest without changing judgments.
          for (let repeat = 0; repeat < 3; repeat++) {
            const writeStart = performance.now();
            if (usesGrams) await tx`DELETE FROM keyword_eval_portable.tokens`;
            for (const chunk of keywordCorpus.chunks) {
              const content = normalizeKeyword(chunk.content);
              await tx`UPDATE keyword_eval_portable.chunks SET content = ${content} WHERE id = ${chunk.id}`;
              if (usesGrams)
                await tx`INSERT INTO keyword_eval_portable.tokens ${tx(keywordNgrams(content, provider.startsWith('trigram') ? 3 : 2).map((token) => ({ chunk_id: chunk.id, token })))}`;
            }
            writeMs.push(performance.now() - writeStart);
          }
          await tx`ANALYZE keyword_eval_portable.chunks`;
          if (usesGrams) await tx`ANALYZE keyword_eval_portable.tokens`;
          // Match baseline's index-forced conditions; also retain natural-planner EXPLAIN below.
          await tx`SET LOCAL enable_seqscan = off`;
          const cases: KeywordRun['cases'][number][] = [];
          for (const test of keywordCorpus.cases) {
            if (test.query.length > keywordCorpus.maxQueryLength) {
              cases.push({ id: test.id, status: 'rejected', chunkIds: [], latencyMs: [0] });
              continue;
            }
            const latencyMs = [];
            let chunkIds: string[] = [];
            for (let iteration = 0; iteration < 4; iteration++) {
              const start = performance.now();
              const query = normalizeKeyword(test.query);
              const rows: readonly unknown[] = query
                ? await portableQuery(tx, provider, test.projectId, query)
                : [];
              const elapsed = performance.now() - start;
              const current = rows.map(candidateId);
              if (iteration > 0 && JSON.stringify(current) !== JSON.stringify(chunkIds))
                throw new Error('Unstable portable ranks.');
              chunkIds = current;
              if (iteration > 0) latencyMs.push(elapsed);
            }
            cases.push({ id: test.id, status: 'ok', chunkIds, latencyMs });
          }
          const explain = [];
          for (const seqscan of [false, true]) {
            if (seqscan) await tx`SET LOCAL enable_seqscan = on`;
            for (const id of ['japanese', 'typo', 'query-injection', 'isolation']) {
              const test = keywordCorpus.cases.find((c) => c.id === id);
              if (!test) throw new Error('Missing diagnostic case.');
              const rows: readonly unknown[] =
                await tx`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${portableQuery(tx, provider, test.projectId, normalizeKeyword(test.query))}`;
              explain.push({ id, seqscan, plan: rows.map((row) => textField(row, 'QUERY PLAN')) });
            }
          }
          const sizes: readonly unknown[] =
            await tx`SELECT relname AS name, pg_relation_size(oid)::text AS bytes FROM pg_class WHERE relnamespace = 'keyword_eval_portable'::regnamespace AND relkind IN ('r','i') ORDER BY relname`;
          const relations = sizes.map((row) => ({
            name: textField(row, 'name'),
            bytes: Number(textField(row, 'bytes')),
          }));
          const debugRows: readonly unknown[] =
            await tx`SELECT token, alias FROM ts_debug('simple', ${normalizeKeyword(keywordCorpus.chunks[0]?.content ?? '')})`;
          const parserTokens = debugRows.map((row) => ({
            token: textField(row, 'token'),
            alias: textField(row, 'alias'),
          }));
          if (usesGrams) await tx`DROP TABLE keyword_eval_portable.tokens`;
          await tx`DROP TABLE keyword_eval_portable.chunks`;
          await tx`DROP SCHEMA keyword_eval_portable`;
          const run: KeywordRun = {
            schemaVersion: 1,
            corpusHash,
            provider,
            environment: `PostgreSQL ${version.postgres}; pg_trgm ${version.trgm}; NFKC+lower; isolated index; seqscan off; warmup=1; repetitions=3; similarity=0.3; word=0.6`,
            cases,
          };
          return {
            run,
            diagnostics: {
              provider,
              loadMs,
              buildMs,
              writeMs,
              tokenRows: tokens.length,
              relations,
              parserTokens,
              explain,
            },
          };
        }),
      );
    }
    return results;
  } finally {
    await sql.end();
  }
}

function textField(row: unknown, key: string): string {
  if (!row || typeof row !== 'object' || !(key in row)) throw new Error('Invalid diagnostic row.');
  const value: unknown = Reflect.get(row, key);
  if (typeof value !== 'string') throw new Error('Invalid diagnostic field.');
  return value;
}

function candidateId(row: unknown): string {
  return textField(row, 'id');
}
