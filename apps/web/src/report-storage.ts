import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createObjectStorageFromEnv } from '../../../packages/storage/src/factory.ts';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';

export function createReportStorageFromEnv(): ObjectStorage {
  const driver = process.env.STORAGE_DRIVER ?? process.env.OBJECT_STORAGE_DRIVER ?? 'local';
  return createObjectStorageFromEnv({
    ...process.env,
    STORAGE_DRIVER: driver,
    STORAGE_ROOT:
      driver === 'local'
        ? (process.env.STORAGE_ROOT ?? process.env.LOCAL_STORAGE_ROOT ?? localDevStorageRoot())
        : process.env.STORAGE_ROOT,
  });
}

function localDevStorageRoot(): string | undefined {
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }
  const candidates = [
    resolve(process.cwd(), '.data/volumes/pufu-lens-data'),
    resolve(process.cwd(), '../../.data/volumes/pufu-lens-data'),
    resolve(process.cwd(), 'infra/volumes/pufu-lens-data'),
    resolve(process.cwd(), '../../infra/volumes/pufu-lens-data'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
