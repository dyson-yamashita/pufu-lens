import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { corpusHash, type KeywordRun } from './keyword-eval.ts';
import { type KeywordEvalCase, keywordCorpus } from './keyword-eval-corpus.ts';

/**
 * Measures the existing PGroonga ranking policy against synthetic data on a local evaluation DB.
 * Requires preinstalled PGroonga; creates and drops its own schema in one transaction, never app tables.
 * Rejects remote URLs and does not read DATABASE_URL. No credentials or query text enter the result.
 */
export async function collectPgroongaBaseline(databaseUrl: string): Promise<KeywordRun> {
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/keyword_eval' ||
    url.search
  ) {
    throw new Error(
      'KEYWORD_EVAL_DATABASE_URL must be a loopback evaluation DB URL without options.',
    );
  }
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const run = await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '10s'`;
      const versions: readonly unknown[] =
        await tx`SELECT current_setting('server_version') AS postgres, extversion AS pgroonga FROM pg_extension WHERE extname = 'pgroonga'`;
      const version = versions[0];
      if (
        !version ||
        typeof version !== 'object' ||
        !('postgres' in version) ||
        !('pgroonga' in version) ||
        typeof version.postgres !== 'string' ||
        typeof version.pgroonga !== 'string'
      )
        throw new Error('PGroonga must be installed on the evaluation DB.');
      // PGroonga 4.0.6 score lookup fails on TEMP indexes. Keep ordinary tables isolated
      // and transaction-scoped instead; an existing schema is an error, never reused/deleted.
      await tx`CREATE SCHEMA keyword_eval_synthetic`;
      await tx`CREATE TABLE keyword_eval_synthetic.chunks (id text PRIMARY KEY, document_id text NOT NULL, project_id text NOT NULL, content text NOT NULL)`;
      await tx`INSERT INTO keyword_eval_synthetic.chunks ${tx(keywordCorpus.chunks.map((chunk) => ({ id: chunk.id, document_id: chunk.documentId, project_id: chunk.projectId, content: chunk.content })))}`;
      await tx`CREATE INDEX ON keyword_eval_synthetic.chunks USING pgroonga(content)`;
      await tx`ANALYZE keyword_eval_synthetic.chunks`;
      // Small fixtures otherwise favor a sequential scan, for which PGroonga scores are zero.
      await tx`SET LOCAL enable_seqscan = off`;
      const cases: KeywordRun['cases'][number][] = [];
      for (const test of keywordCorpus.cases as readonly KeywordEvalCase[]) {
        if (test.query.length > keywordCorpus.maxQueryLength) {
          cases.push({ id: test.id, status: 'rejected', chunkIds: [], latencyMs: [0] });
          continue;
        }
        const latencyMs: number[] = [];
        let chunkIds: string[] = [];
        // One warm-up and three measured repetitions, with stable ordering required.
        for (let iteration = 0; iteration < 4; iteration += 1) {
          const start = performance.now();
          // Mirrors postgres-chat-candidate-adapters.ts: chunk limit BEFORE document dedupe,
          // pgroonga_query_escape, score DESC / chunk ID ties. No production tables are accessed.
          const rows: readonly unknown[] =
            test.query.trim() === ''
              ? []
              : await tx`
            WITH limited AS (
              SELECT id, document_id, pgroonga_score(tableoid, ctid) AS score
              FROM keyword_eval_synthetic.chunks
              WHERE project_id = ${test.projectId}
                AND content &@~ pgroonga_query_escape(${test.query.trim()})
              ORDER BY pgroonga_score(tableoid, ctid) DESC, id
              LIMIT ${keywordCorpus.k}
            ), deduped AS (
              SELECT DISTINCT ON (document_id) id, document_id, score
              FROM limited ORDER BY document_id, score DESC, id
            ) SELECT id FROM deduped ORDER BY score DESC, id LIMIT ${keywordCorpus.k}
          `;
          const elapsed = performance.now() - start;
          const current = rows.map((row) => {
            if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string')
              throw new Error('Invalid PGroonga candidate row.');
            return row.id;
          });
          if (iteration > 0 && JSON.stringify(current) !== JSON.stringify(chunkIds))
            throw new Error('Unstable PGroonga ranks.');
          chunkIds = current;
          if (iteration > 0) latencyMs.push(elapsed);
        }
        cases.push({ id: test.id, status: 'ok', chunkIds, latencyMs });
      }
      await tx`DROP TABLE keyword_eval_synthetic.chunks`;
      await tx`DROP SCHEMA keyword_eval_synthetic`;
      return {
        schemaVersion: 1 as const,
        corpusHash,
        provider: 'pgroonga',
        environment: `PostgreSQL ${version.postgres}; PGroonga ${version.pgroonga}; isolated index; seqscan off; warmup=1; repetitions=3`,
        cases,
      };
    });
    return run;
  } finally {
    await sql.end();
  }
}
