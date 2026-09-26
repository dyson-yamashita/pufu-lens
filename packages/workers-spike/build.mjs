import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Bundles only public Core package exports, rejecting Node builtins and unresolved externals. */
export async function buildWorker() {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
    entryPoints: ['src/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    metafile: true,
    write: false,
    outfile: 'dist/worker.js',
  });
  // No external modules, Node polyfills, or provider implementations belong in this spike.
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    if (path.includes('node_modules') || /postgres-|\/ingestion\//.test(path)) {
      throw new Error(`Unexpected Worker dependency: ${path}`);
    }
    if (input.imports.some((entry) => entry.external)) {
      throw new Error(`External Worker dependency: ${path}`);
    }
  }
  const script = result.outputFiles[0].text;
  await mkdir(new URL('dist/', import.meta.url), { recursive: true });
  await writeFile(new URL('dist/worker.js', import.meta.url), script);
  await writeFile(
    new URL('dist/metafile.json', import.meta.url),
    JSON.stringify(result.metafile, null, 2),
  );
  return { script, metafile: result.metafile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { script } = await buildWorker();
  console.log(`Workers Core bundle: ${Buffer.byteLength(script)} bytes`);
}
