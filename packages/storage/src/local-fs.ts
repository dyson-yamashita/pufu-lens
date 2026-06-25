import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ObjectInfo,
  ObjectStorage,
  ProjectStoragePrefixes,
  PutOptions,
} from './object-storage.ts';

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export class LocalFsObjectStorage implements ObjectStorage {
  readonly root: string;

  constructor(root: string) {
    if (!root) {
      throw new Error('LocalFsObjectStorage requires a storage root.');
    }

    this.root = resolve(root);
  }

  async put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    _opts?: PutOptions,
  ): Promise<{ etag?: string; uri: string }> {
    const filePath = this.pathForUri(uri);
    await mkdir(dirname(filePath), { recursive: true });

    let etag: string;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const buffer = Buffer.from(body);
      await writeFile(filePath, buffer);
      etag = createHash('sha256').update(buffer).digest('hex');
    } else {
      const hash = createHash('sha256');
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(filePath),
      );
      etag = hash.digest('hex');
    }

    return {
      etag,
      uri: this.uriForPath(filePath),
    };
  }

  async get(uri: string): Promise<ReadStream> {
    const filePath = this.pathForUri(uri);
    await stat(filePath);
    return createReadStream(filePath);
  }

  async getText(uri: string): Promise<string> {
    return readFile(this.pathForUri(uri), 'utf8');
  }

  async exists(uri: string): Promise<boolean> {
    try {
      await stat(this.pathForUri(uri));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }

      throw error;
    }
  }

  async delete(uri: string): Promise<void> {
    await rm(this.pathForUri(uri), { force: true });
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const prefixPath = this.pathForUri(prefix);
    let walkRootPath = prefixPath;
    let filterPrefixPath: string | undefined;

    try {
      const prefixStat = await stat(prefixPath);
      if (prefixStat.isFile()) {
        yield {
          size: prefixStat.size,
          updatedAt: prefixStat.mtime,
          uri: this.uriForPath(prefixPath),
        };
        return;
      }
    } catch (error) {
      if (isNotFound(error)) {
        walkRootPath = dirname(prefixPath);
        filterPrefixPath = prefixPath;
        try {
          const walkRootStat = await stat(walkRootPath);
          if (!walkRootStat.isDirectory()) {
            return;
          }
        } catch (walkRootError) {
          if (isNotFound(walkRootError)) {
            return;
          }

          throw walkRootError;
        }
      } else {
        throw error;
      }
    }

    for await (const item of this.walk(walkRootPath, filterPrefixPath)) {
      yield item;
    }
  }

  async ensureProjectPrefixes(projectSlug: string): Promise<ProjectStoragePrefixes> {
    if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
      throw new Error(`Invalid project slug: ${projectSlug}`);
    }

    const prefixes = {
      parsed: this.uriForRelativePath(join(projectSlug, 'parsed')),
      raw: this.uriForRelativePath(join(projectSlug, 'raw')),
      reports: this.uriForRelativePath(join(projectSlug, 'reports')),
    };

    await Promise.all(
      Object.values(prefixes).map((prefix) => mkdir(this.pathForUri(prefix), { recursive: true })),
    );

    return prefixes;
  }

  uriForRelativePath(path: string): string {
    return this.uriForPath(this.safeJoin(path));
  }

  private async *walk(directoryPath: string, filterPrefixPath?: string): AsyncIterable<ObjectInfo> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(entryPath, filterPrefixPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (filterPrefixPath && !entryPath.startsWith(filterPrefixPath)) {
        continue;
      }

      try {
        const entryStat = await stat(entryPath);
        yield {
          size: entryStat.size,
          updatedAt: entryStat.mtime,
          uri: this.uriForPath(entryPath),
        };
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }

        throw error;
      }
    }
  }

  private pathForUri(uri: string): string {
    if (uri.startsWith('file://')) {
      return this.assertInsideRoot(fileURLToPath(uri));
    }

    return this.safeJoin(uri);
  }

  private safeJoin(path: string): string {
    return this.assertInsideRoot(join(this.root, path));
  }

  private assertInsideRoot(path: string): string {
    const absolutePath = resolve(path);
    const rootRelativePath = relative(this.root, absolutePath);
    if (
      rootRelativePath === '..' ||
      rootRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(rootRelativePath)
    ) {
      throw new Error(`Storage path escapes root: ${path}`);
    }

    return absolutePath;
  }

  private uriForPath(path: string): string {
    const absolutePath = this.assertInsideRoot(path);
    return pathToFileURL(absolutePath).toString();
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
