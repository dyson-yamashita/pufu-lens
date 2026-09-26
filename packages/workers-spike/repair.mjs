import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { buildWorker } from './build.mjs';

/** Inspects or requeues one revision in an existing local Miniflare D1 store. Never contacts remote services.
 * The store must use DB identity semantic-local and already contain migration 0003. Close other local
 * runtimes before running. Default is read-only inspection; --revision N --apply requeues exactly N.
 */
export async function runRepair(args) {
  const allowed = new Set(['--state-dir', '--project', '--document', '--revision', '--apply']);
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!allowed.has(option) || options.has(option)) throw new Error('Invalid repair option');
    if (option === '--apply') options.set(option, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing repair option value');
      options.set(option, value);
    }
  }
  for (const key of ['--state-dir', '--project', '--document'])
    if (!options.has(key)) throw new Error('Missing repair scope');
  const directory = resolve(options.get('--state-dir'));
  if (!(await stat(directory)).isDirectory()) throw new Error('Local D1 store must exist');
  const revision = options.has('--revision') ? Number(options.get('--revision')) : undefined;
  if (
    (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) ||
    (options.has('--apply') && revision === undefined)
  )
    throw new Error('Repair requires one positive revision');
  const { script } = await buildWorker('semantic-worker');
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'semantic-local' },
    d1Persist: directory,
    outboundService: () => new Response(null, { status: 403 }),
  });
  try {
    const input = {
      projectId: options.get('--project'),
      documentId: options.get('--document'),
      revision,
    };
    const response = await runtime.dispatchFetch('http://local.test/semantic', {
      method: 'POST',
      body: JSON.stringify({ operation: options.has('--apply') ? 'repair' : 'inspect', input }),
    });
    if (!response.ok) throw new Error('Local repair failed; check schema and scope');
    return (await response.json()).result;
  } finally {
    await runtime.dispose();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runRepair(process.argv.slice(2))));
  } catch {
    console.error(
      'Local repair failed. Require --state-dir PATH --project ID --document ID [--revision N --apply].',
    );
    process.exitCode = 1;
  }
}
