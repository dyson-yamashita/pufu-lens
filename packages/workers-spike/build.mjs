import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Bundles the local Core or D1 harness through public Core exports; rejects Node/GCP dependencies. */
export async function buildWorker(entry = 'worker') {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
    entryPoints: [`src/${entry}.ts`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    metafile: true,
    write: false,
    outfile: `dist/${entry}.js`,
  });
  // No external modules, Node polyfills, or GCP implementations belong in this spike.
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    const embeddingClient = /\/ingestion\/dist\/(embedding-client|http-retry)\.js$/.test(path);
    if (
      path.includes('node_modules') ||
      /postgres-/.test(path) ||
      (path.includes('/ingestion/') && !embeddingClient)
    ) {
      throw new Error(`Unexpected Worker dependency: ${path}`);
    }
    if (input.imports.some((entry) => entry.external)) {
      throw new Error(`External Worker dependency: ${path}`);
    }
  }
  const script = result.outputFiles[0].text;
  await mkdir(new URL('dist/', import.meta.url), { recursive: true });
  await writeFile(new URL(`dist/${entry}.js`, import.meta.url), script);
  await writeFile(
    new URL(`dist/${entry === 'worker' ? 'metafile' : `${entry}-metafile`}.json`, import.meta.url),
    JSON.stringify(result.metafile, null, 2),
  );
  return { script, metafile: result.metafile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { script } = await buildWorker();
  console.log(`Workers Core bundle: ${Buffer.byteLength(script)} bytes`);
  const d1 = await buildWorker('d1-worker');
  console.log(`Workers D1 bundle: ${Buffer.byteLength(d1.script)} bytes`);
  const keyword = await buildWorker('keyword-worker');
  console.log(`Workers keyword bundle: ${Buffer.byteLength(keyword.script)} bytes`);
  const semantic = await buildWorker('semantic-worker');
  console.log(`Workers semantic bundle: ${Buffer.byteLength(semantic.script)} bytes`);
  const staging = await buildWorker('staging-worker');
  console.log(`Workers staging bundle: ${Buffer.byteLength(staging.script)} bytes`);
}
