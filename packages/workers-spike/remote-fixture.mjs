import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Checks the management API metadata index list before any vector is inserted.
 * Cloudflare has returned both documented `string` and observed `String` type names.
 * Only these two spellings and both required properties satisfy the deployment contract.
 */
export function metadataReady(result) {
  return (
    Array.isArray(result?.metadataIndexes) &&
    ['projectId', 'model'].every((property) =>
      result.metadataIndexes.some(
        (index) =>
          index?.propertyName === property && ['string', 'String'].includes(index.indexType),
      ),
    )
  );
}

/** Runs the approved tiny fixture against an injected transport, waiting for observable visibility.
 * All requests, including failed polls, consume budgets. Unknown usage or transport failures stop
 * the run; writes are never automatically retried. This performs no provisioning or cleanup.
 */
export async function runRemoteFixture(
  call,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), progress = () => {} } = {},
) {
  const report = {
    fixture: 'cloudflare-composition-v1',
    schema: '0004_composition',
    model: 'synthetic-v1',
    dimensions: 1536,
    requests: 0,
    queries: 0,
    upsertedVectors: 0,
    rowsRead: 0,
    rowsWritten: 0,
    databaseBytes: 0,
    unavailablePolls: 0,
    visibility: [],
    stages: [],
    outcome: 'running',
    parityGate: 'not-run',
  };
  const started = Date.now();
  const invoke = async (operation, input = {}, expected) => {
    // Reserve room for one complete invocation instead of detecting overruns only after writes.
    if (
      report.requests >= 400 ||
      report.queries >= 200 ||
      report.upsertedVectors + (operation === 'dispatch' ? 8 : 0) > 100 ||
      report.rowsRead >= 80_000 ||
      report.rowsWritten >= 6_000 ||
      report.databaseBytes > 5_000_000 ||
      Date.now() - started > 900_000
    )
      throw new Error('Remote fixture budget exhausted');
    report.requests++;
    const response = await call(operation, input);
    if (response.body.usage) {
      const u = response.body.usage;
      if (u.complete !== true) throw new Error('Incomplete remote usage');
      for (const key of ['queries', 'upsertedVectors', 'rowsRead', 'rowsWritten', 'databaseBytes'])
        if (!Number.isSafeInteger(u[key]) || u[key] < 0) throw new Error('Invalid remote usage');
      for (const key of ['queries', 'upsertedVectors', 'rowsRead', 'rowsWritten'])
        report[key] += u[key];
      report.databaseBytes = Math.max(report.databaseBytes, u.databaseBytes);
    } else if (![400, 401].includes(expected)) throw new Error('Missing remote usage');
    if (
      report.queries > 300 ||
      report.upsertedVectors > 144 ||
      report.rowsRead > 100_000 ||
      report.rowsWritten > 10_000 ||
      report.databaseBytes > 5_000_000
    )
      throw new Error('Remote usage exceeded budget');
    if (expected) {
      assert.equal(response.status, expected);
      return response;
    }
    if (![200, 503].includes(response.status))
      throw new Error(`Unexpected status ${response.status}`);
    if (response.status === 200) {
      assert.equal(response.body.fixture, report.fixture);
      assert.equal(response.body.schema, report.schema);
      assert.equal(response.body.model, report.model);
      assert.equal(response.body.dimensions, report.dimensions);
    }
    return response;
  };
  const ok = async (operation, input) => {
    const result = await invoke(operation, input);
    assert.equal(result.status, 200, `${operation} unavailable`);
    if (operation === 'dispatch')
      assert.ok(
        result.body.result.every((r) => ['submitted', 'skipped'].includes(r.state)),
        'Delivery retry/dead requires investigation',
      );
    return result.body.result;
  };
  const visible = async (projectId, document, revision, deleted = false) => {
    const start = Date.now();
    for (let attempt = 1; attempt <= 20; attempt++) {
      const response = await invoke('query', { projectId, document });
      if (response.status === 503) report.unavailablePolls++;
      else {
        const result = response.body.result;
        const target = `doc-${document}`;
        const complete = deleted
          ? result.semantic.length === 3 &&
            !result.semantic.includes(target) &&
            result.keyword.length === 0 &&
            !result.hybrid.includes(target)
          : result.semantic.length === 4 &&
            result.semantic[0] === target &&
            result.keyword.length === 1 &&
            result.keyword[0] === target &&
            result.hybrid[0] === target &&
            result.semanticDetails[0]?.rawDocumentId === `${target}-raw-${revision}`;
        if (complete) {
          if (!deleted) {
            assert.ok(
              result.semanticDetails[0].cosineDistance >= 0 &&
                result.semanticDetails[0].cosineDistance < 0.02,
            );
            if (document === 0) assert.equal(result.graph[0]?.documentId, 'doc-1');
          }
          report.visibility.push({
            projectId,
            document,
            revision,
            deleted,
            polls: attempt,
            elapsedMs: Date.now() - start,
          });
          return;
        }
      }
      if (attempt < 20) await sleep(10_000);
    }
    throw new Error('Visibility deadline exceeded');
  };
  try {
    await invoke('health', { unauthorized: true }, 401);
    await invoke('seed', { projectId: 'forbidden-project' }, 400);
    await ok('health');
    for (const projectId of ['fixture-alpha', 'fixture-beta']) {
      for (let document = 0; document < 4; document++) await ok('seed', { projectId, document });
      await ok('graph', { projectId });
      await ok('dispatch', { projectId });
    }
    for (const projectId of ['fixture-alpha', 'fixture-beta']) {
      for (let document = 0; document < 4; document++) await visible(projectId, document, 1);
      await ok('seed', { projectId, revision: 2 });
      await invoke('query', { projectId }, 503); // old visible vectors must not hydrate as revision 2
      await ok('seed', { projectId, revision: 1 });
      await ok('dispatch', { projectId });
      await visible(projectId, 0, 2);
      await ok('repair', { projectId, revision: 1 });
      await ok('repair', { projectId, revision: 2 });
      await ok('dispatch', { projectId });
      await visible(projectId, 0, 2);
      await ok('seed', { projectId, revision: 3 });
      await invoke('query', { projectId }, 503);
      await ok('dispatch', { projectId });
      // Repeat the deletion check to avoid calling one transient observation convergence.
      for (let i = 0; i < 3; i++) {
        await visible(projectId, 0, 3, true);
        await sleep(2000);
      }
      report.stages.push({ projectId, outcome: 'passed' });
      progress({ projectId, requests: report.requests, queries: report.queries });
    }
    report.outcome = 'passed';
  } catch (error) {
    report.outcome = 'failed';
    // Only our own static diagnostic classes are published, never response/error bodies.
    report.failure =
      error instanceof assert.AssertionError
        ? 'assertion_failed'
        : String(error.message).startsWith('Visibility')
          ? 'visibility_timeout'
          : 'transport_or_budget_or_usage';
  }
  report.elapsedMs = Date.now() - started;
  return report;
}

/** Creates a no-redirect HTTPS transport to one approved workers.dev evaluation origin.
 * Reads the dedicated token from a private local file; never uses the Cloudflare management token.
 */
export async function remoteTransport(origin, tokenFile) {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^pufu-6e-composition-check(?:-[0-9]+)?\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
  )
    throw new Error('Invalid dedicated staging origin');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Invalid evaluation token');
  return async (operation, input) => {
    const { unauthorized, ...control } = input;
    const response = await fetch(new URL('/evaluate', url), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${unauthorized ? 'invalid' : token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation,
        projectId: 'fixture-alpha',
        document: 0,
        revision: 1,
        ...control,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [origin, tokenFile, reportFile, ...extra] = process.argv.slice(2);
  if (!origin || !tokenFile || !reportFile || extra.length)
    throw new Error('Expected origin, token file, report file');
  const report = await runRemoteFixture(await remoteTransport(origin, tokenFile), {
    progress: (value) => console.log(JSON.stringify(value)),
  });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      requests: report.requests,
      queries: report.queries,
      failure: report.failure,
    }),
  );
  if (report.outcome !== 'passed') process.exitCode = 1;
}
