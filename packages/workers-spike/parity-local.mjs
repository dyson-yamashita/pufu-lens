import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { corpusHash } from '../../scripts/lib/keyword-eval.ts';
import { collectPgroongaBaseline } from '../../scripts/lib/keyword-eval-pgroonga.ts';
import { collectSyntheticChat } from '../../scripts/lib/parity-chat.ts';
import { collectLocalChatFailures } from '../../scripts/lib/parity-chat-failures.ts';
import { readParityEmbeddingArtifact } from '../../scripts/lib/parity-embedding-artifact.ts';
import { evaluateParity, parseParityRun } from '../../scripts/lib/parity-eval.ts';
import { parityFixture } from '../../scripts/lib/parity-fixture.ts';
import { collectPostgresGraphParity } from '../../scripts/lib/parity-graph-postgres.ts';
import {
  collectPostgresSyntheticRetrieval,
  withPostgresParityCandidates,
} from '../../scripts/lib/parity-retrieval-postgres.ts';
import { localKeywordSnapshot } from '../../scripts/lib/parity-runner.ts';
import { buildWorker } from './build.mjs';
import { collectD1SyntheticChat } from './parity-chat-local.mjs';
import { collectD1GraphParity } from './parity-graph-local.mjs';
import { collectD1SyntheticRetrieval } from './parity-retrieval-local.mjs';

/** Measures the fixed parity keyword inputs in disposable real D1/workerd with all egress denied.
 * Uses the existing D1 adapter harness, not the fixed Step 6 composition endpoint/Vectorize fake.
 */
export async function collectD1ParityKeywords() {
  const { script } = await buildWorker('keyword-worker');
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'parity-local' },
    outboundService: () => new Response(null, { status: 403 }),
  });
  try {
    await runtime.ready;
    const db = await runtime.getD1Database('DB');
    for (const file of ['0001_graph.sql', '0002_keyword.sql']) {
      const sql = await readFile(new URL(`d1/${file}`, import.meta.url), 'utf8');
      await db.batch(
        sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    for (const id of new Set(parityFixture.chunks.map((c) => c.projectId)))
      await db.prepare('INSERT INTO projects VALUES (?)').bind(id).run();
    const call = async (operation, input) => {
      const response = await runtime.dispatchFetch('http://local.test/keyword', {
        method: 'POST',
        body: JSON.stringify({ operation, input }),
      });
      return { status: response.status, body: await response.json() };
    };
    for (const id of new Set(parityFixture.chunks.map((c) => c.documentId))) {
      const chunks = parityFixture.chunks.filter((c) => c.documentId === id);
      const result = await call('replace', {
        projectId: chunks[0].projectId,
        documentId: id,
        rawDocumentId: `raw-${id}`,
        title: id,
        canonicalUri: `https://synthetic.invalid/${id}`,
        docType: 'web_page',
        chunks: chunks.map((c, chunkIndex) => ({ chunkId: c.id, content: c.content, chunkIndex })),
      });
      if (result.status !== 200) throw new Error('Local fixture ingestion failed');
    }
    const cases = [];
    for (const test of parityFixture.cases.filter((test) => test.kind === 'keyword')) {
      const start = performance.now();
      const { status, body } = await call('search', {
        projectId: test.projectId,
        normalizedQuery: test.query,
        limit: 20,
      });
      const latencyMs = [performance.now() - start];
      if (status !== 200 && !(status === 400 && body.error === 'rejected'))
        throw new Error('Local keyword adapter unavailable');
      if (
        status === 200 &&
        (!Array.isArray(body.result) ||
          body.result.some(
            (row) =>
              !row ||
              typeof row.chunkId !== 'string' ||
              typeof row.documentId !== 'string' ||
              !parityFixture.chunks.some(
                (c) => c.id === row.chunkId && c.documentId === row.documentId,
              ),
          ))
      )
        throw new Error('Invalid local candidate provenance');
      cases.push({
        id: test.id.slice('keyword-'.length),
        status: status === 200 ? 'ok' : 'rejected',
        chunkIds: status === 200 ? body.result.map((row) => row.chunkId) : [],
        latencyMs,
      });
    }
    return {
      schemaVersion: 1,
      corpusHash,
      provider: 'd1-character-bigram',
      environment: 'local-workerd',
      cases,
    };
  } finally {
    await runtime.dispose();
  }
}

/** Local CLI: fresh observations only; optional loopback PGroonga, no remote execution path.
 * Writes identifiers/metrics only. A successful process means collection completed, not quality passed.
 * A saved artifact is validated before DB work and used for retrieval only; Chat is skipped.
 */
export async function runLocalParity(outputDirectory, databaseUrl, artifactPath) {
  // Fail closed before any collector creates a DB; never fall back to hash vectors.
  const artifact =
    artifactPath === undefined ? null : await readParityEmbeddingArtifact(artifactPath);
  const gitOptions = { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' };
  const codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  }).trim();
  const codeDirty = execFileSync('git', ['status', '--porcelain'], gitOptions).trim() !== '';
  const runId = `local-${Date.now()}`;
  const baseline = localKeywordSnapshot(
    'gcp',
    codeCommit,
    `${runId}-gcp`,
    databaseUrl ? await collectPgroongaBaseline(databaseUrl) : null,
    databaseUrl ? await collectPostgresGraphParity(databaseUrl) : null,
  );
  const candidate = localKeywordSnapshot(
    'cloudflare',
    codeCommit,
    `${runId}-cloudflare`,
    await collectD1ParityKeywords(),
    await collectD1GraphParity(),
  );
  // Separate snapshots prevent fake/synthetic rows being mistaken for quality measurements.
  const syntheticEvidence = (base, run, adapters) =>
    run === null
      ? null
      : {
          ...run,
          rows: undefined,
          adapters,
          snapshot: parseParityRun({
            metadata: {
              ...base.snapshot.metadata,
              runId: `${base.snapshot.metadata.runId}-synthetic`,
              embedding: run.embedding,
            },
            rows: run.rows,
          }),
        };
  const syntheticRetrieval = artifact
    ? null
    : {
        gcp: syntheticEvidence(
          baseline,
          databaseUrl ? await collectPostgresSyntheticRetrieval(databaseUrl) : null,
          'local-pgvector-pgroonga',
        ),
        cloudflare: syntheticEvidence(
          candidate,
          await collectD1SyntheticRetrieval(),
          'real-d1-workerd-fake-vectorize',
        ),
      };
  const artifactRetrieval = artifact
    ? {
        provenance: artifact.provenance,
        gcp: databaseUrl
          ? {
              ...(await collectPostgresSyntheticRetrieval(databaseUrl, artifact.input)),
              adapters: 'local-pgvector-pgroonga',
            }
          : null,
        cloudflare: {
          ...(await collectD1SyntheticRetrieval(artifact.input)),
          adapters: 'real-d1-workerd-fake-vectorize',
        },
        qualityGate: false,
      }
    : null;
  const report = {
    ...evaluateParity(candidate.snapshot, baseline.snapshot),
    localEvidence: {
      codeDirty,
      gcp: baseline.evidence,
      cloudflare: candidate.evidence,
      syntheticRetrieval,
      artifactRetrieval,
      chatArtifactSupport: 'unsupported-derived-query-vectors-not-provided',
      syntheticChat: artifact
        ? null
        : {
            gcp: syntheticEvidence(
              baseline,
              databaseUrl
                ? await withPostgresParityCandidates(databaseUrl, collectSyntheticChat)
                : null,
              'local-pgvector-pgroonga',
            ),
            cloudflare: syntheticEvidence(
              candidate,
              await collectD1SyntheticChat(),
              'real-d1-workerd-fake-vectorize',
            ),
          },
      sharedChatFailures: await collectLocalChatFailures(),
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, value] of [
    ['gcp', baseline.snapshot],
    ['cloudflare', candidate.snapshot],
    ['report', report],
  ])
    await writeFile(
      resolve(outputDirectory, `${name}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  await writeFile(
    resolve(outputDirectory, 'summary.md'),
    `# Local backend parity\n\nGCP: ${baseline.snapshot.rows.length}/52; Cloudflare: ${candidate.snapshot.rows.length}/52 measured rows.\n\nqualityGate: ${report.qualityGate}; Step 7: ${report.step7Gate}.\n\nRetrieval input: ${artifact ? 'saved-artifact; origin unverified; Chat unsupported and skipped' : 'synthetic hash vectors'}. Separate local retrieval evidence: GCP ${artifactRetrieval?.gcp?.rows.length ?? syntheticRetrieval?.gcp?.snapshot.rows.length ?? 0}/6; Cloudflare ${artifactRetrieval?.cloudflare.rows.length ?? syntheticRetrieval?.cloudflare.snapshot.rows.length ?? 0}/6. Fake Vectorize is not remote evidence. Quality snapshots keep these cases missing.\n\nGraph includes persisted before/after state, retry and tenant-sentinel checks. Keyword/retrieval mutation, Chat rubric, real embedding quality and remote metrics remain unmeasured. MENTIONS v1 expects direct 1-hop; adapters support Topic-mediated 2-hop, so inspect its mismatch in report.json.\n`,
  );
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const output = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
  let artifactPath;
  if (
    args.length === 2 &&
    args[0] === '--embedding-artifact' &&
    args[1] &&
    !args[1].startsWith('--')
  )
    artifactPath = args[1];
  else if (args.length)
    throw new Error('Usage: parity-local.mjs [output-directory] [--embedding-artifact path]');
  const report = await runLocalParity(
    output ?? fileURLToPath(new URL('dist/parity-local', import.meta.url)),
    process.env.KEYWORD_EVAL_DATABASE_URL,
    artifactPath,
  );
  console.log(
    JSON.stringify({
      qualityGate: report.qualityGate,
      step7Gate: report.step7Gate,
      comparisonComplete: report.comparisonComplete,
    }),
  );
}
