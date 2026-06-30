import { createObjectStorageFromEnv } from '../../../packages/storage/src/factory.ts';
import type {
  ObjectStorage,
  ProjectStoragePrefixes,
} from '../../../packages/storage/src/object-storage.ts';

const PROJECT_STORAGE_DELETE_BATCH_SIZE = 50;

export interface ProjectStorageCleanupResult {
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly failedObjectSamples: readonly string[];
}

export type PreparedProjectStorageCleanup = () => Promise<ProjectStorageCleanupResult>;

export async function prepareProjectStorageCleanup(
  projectSlug: string,
): Promise<PreparedProjectStorageCleanup> {
  const driver = process.env.STORAGE_DRIVER ?? process.env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver === 'local' && !process.env.STORAGE_ROOT && !process.env.LOCAL_STORAGE_ROOT) {
    return async () => ({ deletedCount: 0, failedCount: 0, failedObjectSamples: [] });
  }

  const storage = createObjectStorageFromEnv(process.env);
  if (!storage.delete) {
    throw new Error(
      'Configured object storage does not support delete; project storage cleanup cannot complete.',
    );
  }

  const deleteObject = storage.delete.bind(storage);
  const prefix = `${projectSlug}/`;

  return async () => {
    let deletedCount = 0;
    let failedCount = 0;
    const failedObjectSamples: string[] = [];
    let pendingDeletes: Promise<void>[] = [];
    const flushPendingDeletes = async () => {
      if (pendingDeletes.length === 0) {
        return;
      }
      await Promise.all(pendingDeletes);
      pendingDeletes = [];
    };

    try {
      for await (const object of storage.list(prefix)) {
        pendingDeletes.push(
          deleteObject(object.uri)
            .then(() => {
              deletedCount += 1;
            })
            .catch((error) => {
              failedCount += 1;
              if (failedObjectSamples.length < 5) {
                failedObjectSamples.push(object.uri);
              }
              console.warn(
                `Project storage object cleanup failed for ${object.uri}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }),
        );
        if (pendingDeletes.length >= PROJECT_STORAGE_DELETE_BATCH_SIZE) {
          await flushPendingDeletes();
        }
      }
    } finally {
      await flushPendingDeletes();
    }

    return { deletedCount, failedCount, failedObjectSamples };
  };
}

export function formatProjectStorageCleanupFailure(result: ProjectStorageCleanupResult): string {
  const samples =
    result.failedObjectSamples.length > 0
      ? ` Samples: ${result.failedObjectSamples.join(', ')}`
      : '';
  return `Project storage cleanup incomplete: ${result.failedCount} object(s) failed to delete.${samples}`;
}

export async function ensureProjectStoragePrefixes(projectSlug: string): Promise<void> {
  const driver = process.env.STORAGE_DRIVER ?? process.env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver === 'local' && !process.env.STORAGE_ROOT && !process.env.LOCAL_STORAGE_ROOT) {
    return;
  }

  const storage = createObjectStorageFromEnv(process.env);
  if (!hasProjectPrefixSupport(storage)) {
    return;
  }
  await storage.ensureProjectPrefixes(projectSlug);
}

function hasProjectPrefixSupport(storage: ObjectStorage): storage is ObjectStorage & {
  ensureProjectPrefixes(projectSlug: string): Promise<ProjectStoragePrefixes>;
} {
  return 'ensureProjectPrefixes' in storage && typeof storage.ensureProjectPrefixes === 'function';
}
