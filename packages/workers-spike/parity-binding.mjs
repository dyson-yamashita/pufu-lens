import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { normalizeHybridKeywordQuery } from '../../apps/web/src/chat.ts';
import { parseParityEmbeddingArtifact } from '../../scripts/lib/parity-embedding-artifact.ts';
import { parityFixture, parityFixtureHash } from '../../scripts/lib/parity-fixture.ts';
import { parityRetrievalDocuments } from '../../scripts/lib/parity-retrieval.ts';
import { createParityVectorizeFake } from './parity-retrieval-local.mjs';

/** Validates the complete v1 artifact before building a fixed-data binding worker. No network IO.
 * localFake must be explicit; the native bundle requires actual D1/Vectorize bindings.
 */
export async function prepareParityBinding(json, { localFake = false } = {}) {
  if (Buffer.byteLength(json) > 4_000_000) throw new Error('Artifact too large');
  const { input, provenance } = parseParityEmbeddingArtifact(json);
  const artifact = JSON.parse(json);
  const hashes = new Map();
  for (const row of [...artifact.chunks, ...artifact.queries]) {
    const vector = JSON.stringify(row.values);
    if (hashes.has(row.textHash) && hashes.get(row.textHash) !== vector)
      throw new Error('Inconsistent vectors for identical text');
    hashes.set(row.textHash, vector);
  }
  const fixture = {
    version: 'parity-binding-v1',
    fixtureHash: parityFixtureHash,
    artifactHash: input.inputHash,
    model: input.embedding.model,
    documents: parityRetrievalDocuments(input),
    queries: parityFixture.cases
      .filter((c) => c.kind === 'hybrid')
      .map((c) => ({
        id: c.id,
        projectId: c.projectId,
        query: normalizeHybridKeywordQuery(c.query),
        values: input.queryVector(c.id),
      })),
  };
  const wrapper = localFake
    ? `const fake = async (method, args) => {
    const response = await fetch('https://vectorize-fake.invalid/' + method, {method:'POST',body:JSON.stringify(args)});
    if (!response.ok) throw new Error('Fake unavailable'); return response.json();
  }; export default {fetch(request,env) { return worker.fetch(request,{...env,VECTORIZE:{
    describe:()=>fake('describe',{}),query:(values,options)=>fake('query',{values,options}),
    upsert:(values)=>fake('upsert',values),deleteByIds:(ids)=>fake('delete',ids)}}); }};`
    : 'export default worker;';
  const built = await build({
    stdin: {
      contents: `import {createParityBindingWorker} from './src/parity-binding-worker.ts'; const worker=createParityBindingWorker(${JSON.stringify(fixture)}); ${wrapper}`,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2023',
    write: false,
    metafile: true,
  });
  if (
    Object.entries(built.metafile.inputs).some(
      ([path, info]) =>
        path.includes('node_modules') ||
        /postgres-/.test(path) ||
        info.imports.some((i) => i.external),
    )
  )
    throw new Error('Unexpected Worker dependency');
  return {
    script: built.outputFiles[0].text,
    fixture,
    provenance,
    vectorize: localFake ? 'fake-exact-cosine' : 'native-binding-required',
  };
}

/** Creates disposable real workerd/D1 with explicit Vectorize fake; all other egress is denied.
 * Caller owns dispose. Setup failures also dispose the runtime. Never accepts remote credentials.
 */
export async function localParityBinding(json, bindings = {}) {
  const prepared = await prepareParityBinding(json, { localFake: true });
  const fake = createParityVectorizeFake();
  const token = 'local-parity-operator-token-0000000000';
  const runtime = new Miniflare({
    modules: true,
    script: prepared.script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'parity-binding-local' },
    bindings: {
      PUFU_LENS_DATA_PROFILE: 'cloudflare',
      STAGE: 'synthetic-staging',
      FIXTURE_VERSION: prepared.fixture.version,
      FIXTURE_HASH: prepared.fixture.fixtureHash,
      ARTIFACT_HASH: prepared.fixture.artifactHash,
      SCHEMA_VERSION: '0004_composition',
      EMBEDDING_MODEL: prepared.fixture.model,
      EMBEDDING_DIMENSIONS: '1536',
      INDEXED_METADATA: 'projectId,model',
      EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
      EVAL_TOKEN: token,
      ...bindings,
    },
    outboundService: (request) => fake.fetch(request),
  });
  try {
    await runtime.ready;
    const db = await runtime.getD1Database('DB');
    for (const file of [
      '0001_graph.sql',
      '0002_keyword.sql',
      '0003_semantic.sql',
      '0004_composition.sql',
    ]) {
      const sql = await readFile(new URL(`d1/${file}`, import.meta.url), 'utf8');
      await db.batch(
        sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    const call = async (operation, index = 0, extra = {}, secret = token) => {
      const response = await runtime.dispatchFetch('http://local.test/evaluate', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ operation, index, ...extra }),
      });
      return { status: response.status, body: await response.json() };
    };
    return { ...prepared, runtime, db, fake, call };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** Runs the bounded shared retrieval lifecycle. Cleanup runs even after a failed query.
 * Submission is not remote convergence; this report never promotes fake/provenance to quality.
 */
export async function runParityBinding(local) {
  let requests = 0;
  const usage = { rowsRead: 0, rowsWritten: 0, databaseBytes: 0, queries: 0, upsertedVectors: 0 };
  const call = async (operation, index) => {
    if (++requests > 150) throw new Error('Request budget exceeded');
    const response = await local.call(operation, index);
    if (response.status !== 200 || !response.body.usage.complete)
      throw new Error('Binding evaluation failed');
    for (const key of Object.keys(usage)) {
      const value = response.body.usage[key];
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid usage');
      usage[key] = key === 'databaseBytes' ? Math.max(usage[key], value) : usage[key] + value;
    }
    if (['dispatch', 'cleanup'].includes(operation) && response.body.result !== 'submitted')
      throw new Error('Delivery incomplete');
    return response.body.result;
  };
  const results = [];
  const errors = [];
  try {
    for (let i = 0; i < local.fixture.documents.length; i++) {
      await call('seed', i);
      await call('dispatch', i);
    }
    for (let i = 0; i < local.fixture.queries.length; i++) {
      const result = await call('query', i);
      const query = local.fixture.queries[i];
      const allowed = new Set(
        local.fixture.documents
          .filter((d) => d.projectId === query.projectId)
          .flatMap((d) => d.chunks.map((c) => c.candidate.chunkId)),
      );
      if (
        result.caseId !== query.id ||
        !result.semantic.length ||
        [...result.semantic, ...result.keyword, ...result.hybrid].some((id) => !allowed.has(id))
      )
        throw new Error('Missing or foreign binding result');
      results.push(result);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    for (let i = 0; i < local.fixture.documents.length; i++) {
      try {
        await call('cleanup', i);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Binding evaluation failed or cleanup incomplete');
  return {
    requests,
    usage,
    results,
    fixtureHash: local.fixture.fixtureHash,
    artifactHash: local.fixture.artifactHash,
    vectorize: local.vectorize,
    qualityGate: false,
    remoteGate: 'not-run',
    originVerified: false,
  };
}

// Explicit local CLI only: native preparation writes a bundle but never deploys or calls a provider.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, artifactPath, outputDirectory, ...extra] = process.argv.slice(2);
  if (!['prepare', 'local'].includes(mode) || !artifactPath || !outputDirectory || extra.length)
    throw new Error('Usage: parity-binding.mjs prepare|local ARTIFACT OUTPUT_DIRECTORY');
  const json = await readFile(artifactPath, 'utf8');
  const prepared = await prepareParityBinding(json);
  await mkdir(outputDirectory, { recursive: true });
  if (mode === 'prepare') {
    await writeFile(`${outputDirectory}/worker.js`, prepared.script);
    await writeFile(
      `${outputDirectory}/manifest.json`,
      JSON.stringify(
        {
          version: prepared.fixture.version,
          fixtureHash: prepared.fixture.fixtureHash,
          artifactHash: prepared.fixture.artifactHash,
          model: prepared.fixture.model,
          documents: 36,
          chunks: 37,
          queries: 3,
          provenance: prepared.provenance,
          remoteApproved: false,
          remoteGate: 'not-run',
          qualityGate: false,
        },
        null,
        2,
      ),
    );
  } else {
    const local = await localParityBinding(json);
    try {
      await writeFile(
        `${outputDirectory}/report.json`,
        JSON.stringify(await runParityBinding(local), null, 2),
      );
    } finally {
      await local.runtime.dispose();
    }
  }
}
