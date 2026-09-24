import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Replaces a JSON report only after a complete write in the destination filesystem.
 * Serialization/write/rename errors preserve the existing destination and remove owned temporary files.
 * The destination directory must exist. This provides atomic visibility, not power-loss durability.
 */
export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error('Report must be JSON-serializable.');
  const json = `${serialized}\n`;
  const temporaryDirectory = await mkdtemp(join(dirname(path), '.pufu-report-'));
  try {
    const temporaryPath = join(temporaryDirectory, 'report.json');
    await writeFile(temporaryPath, json, { flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
