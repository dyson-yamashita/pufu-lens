import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type {
  ObjectInfo,
  ObjectStorage,
  ProjectStoragePrefixes,
  PutOptions,
} from './object-storage.js';

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

    const buffer = await toBuffer(body);
    await writeFile(filePath, buffer);

    return {
      etag: createHash('sha256').update(buffer).digest('hex'),
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

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const prefixPath = this.pathForUri(prefix);

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
        return;
      }

      throw error;
    }

    for await (const item of this.walk(prefixPath)) {
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

  private async *walk(directoryPath: string): AsyncIterable<ObjectInfo> {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const entryStat = await stat(entryPath);
      yield {
        size: entryStat.size,
        updatedAt: entryStat.mtime,
        uri: this.uriForPath(entryPath),
      };
    }
  }

  private pathForUri(uri: string): string {
    if (uri.startsWith('file://')) {
      return this.assertInsideRoot(new URL(uri).pathname);
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
      rootRelativePath === ''
    ) {
      if (absolutePath !== this.root) {
        throw new Error(`Storage path escapes root: ${path}`);
      }
    }

    return absolutePath;
  }

  private uriForPath(path: string): string {
    const absolutePath = this.assertInsideRoot(path);
    return pathToFileURL(absolutePath).toString();
  }
}

async function toBuffer(body: Buffer | NodeJS.ReadableStream | string): Promise<Buffer> {
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(body)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
