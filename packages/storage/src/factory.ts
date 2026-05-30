import { LocalFsObjectStorage } from './local-fs.js';
import type { ObjectStorage } from './object-storage.js';

export type ObjectStorageDriver = 'gcs' | 'local';

export interface StorageEnv {
  GCS_BUCKET?: string;
  LOCAL_STORAGE_ROOT?: string;
  OBJECT_STORAGE_DRIVER?: string;
  STORAGE_BUCKET?: string;
  STORAGE_DRIVER?: string;
  STORAGE_ROOT?: string;
}

export function createObjectStorageFromEnv(env: StorageEnv = process.env): ObjectStorage {
  const driver = env.STORAGE_DRIVER ?? env.OBJECT_STORAGE_DRIVER ?? 'local';

  if (driver === 'local') {
    const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
    if (!root) {
      throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required for local object storage.');
    }

    return new LocalFsObjectStorage(root);
  }

  if (driver === 'gcs') {
    const bucket = env.STORAGE_BUCKET ?? env.GCS_BUCKET;
    throw new Error(
      `GCS object storage is not implemented yet. Bucket setting: ${bucket ?? '(empty)'}`,
    );
  }

  throw new Error(`Unsupported object storage driver: ${driver}`);
}

export const StorageFactory = {
  fromEnv: createObjectStorageFromEnv,
};
