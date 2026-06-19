import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';
import type {
  ObjectInfo,
  ObjectStorage,
  ProjectStoragePrefixes,
  PutOptions,
} from './object-storage.ts';

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export interface GcsObjectStorageOptions {
  bucket: string;
  storage?: Storage;
}

export class GcsObjectStorage implements ObjectStorage {
  readonly bucketName: string;
  private readonly storage: Storage;

  constructor(options: GcsObjectStorageOptions | string) {
    const bucketName = typeof options === 'string' ? options : options.bucket;
    if (!bucketName) {
      throw new Error('GcsObjectStorage requires a bucket name.');
    }

    this.bucketName = bucketName;
    this.storage = typeof options === 'string' ? new Storage() : (options.storage ?? new Storage());
  }

  async put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    opts?: PutOptions,
  ): Promise<{ etag?: string; uri: string }> {
    const file = this.fileForUri(uri);
    const uploadMetadata = {
      cacheControl: opts?.cacheControl,
      metadata: opts?.metadata,
    };
    const hash = createHash('sha256');
    let etag: string;

    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      etag = hash.update(buffer).digest('hex');
      await file.save(buffer, {
        contentType: opts?.contentType,
        metadata: uploadMetadata,
      });
    } else {
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        file.createWriteStream({
          contentType: opts?.contentType,
          metadata: uploadMetadata,
          resumable: false,
        }),
      );
      etag = hash.digest('hex');
    }

    return {
      etag,
      uri: this.uriForKey(file.name),
    };
  }

  async get(uri: string): Promise<NodeJS.ReadableStream> {
    return this.fileForUri(uri).createReadStream();
  }

  async getText(uri: string): Promise<string> {
    const [buffer] = await this.fileForUri(uri).download();
    return buffer.toString('utf8');
  }

  async exists(uri: string): Promise<boolean> {
    const [exists] = await this.fileForUri(uri).exists();
    return exists;
  }

  async signedUrl(uri: string, ttlSeconds: number): Promise<string> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`signedUrl ttlSeconds must be positive: ${ttlSeconds}`);
    }

    const [url] = await this.fileForUri(uri).getSignedUrl({
      action: 'read',
      expires: Date.now() + ttlSeconds * 1000,
      version: 'v4',
    });
    return url;
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    const normalizedPrefix = this.keyForUri(prefix);
    const directoryPrefix =
      normalizedPrefix && !normalizedPrefix.endsWith('/')
        ? `${normalizedPrefix}/`
        : normalizedPrefix;
    let yieldedDirectoryItems = false;

    for await (const file of this.streamFiles(directoryPrefix)) {
      yieldedDirectoryItems = true;
      yield this.infoForFile(file);
    }
    if (yieldedDirectoryItems || directoryPrefix === normalizedPrefix) {
      return;
    }

    for await (const file of this.streamFiles(normalizedPrefix)) {
      yield this.infoForFile(file);
    }
  }

  private async *streamFiles(prefix: string) {
    const fileStream = this.bucket().getFilesStream({ prefix });
    for await (const file of fileStream) {
      yield file;
    }
  }

  private infoForFile(file: {
    metadata: { size?: number | string; updated?: string };
    name: string;
  }): ObjectInfo {
    const metadata = file.metadata;
    const size = Number(metadata.size ?? 0);
    const updatedAt = metadata.updated ? new Date(metadata.updated) : new Date(0);
    return {
      size,
      updatedAt,
      uri: this.uriForKey(file.name),
    };
  }

  async ensureProjectPrefixes(projectSlug: string): Promise<ProjectStoragePrefixes> {
    if (!PROJECT_SLUG_PATTERN.test(projectSlug)) {
      throw new Error(`Invalid project slug: ${projectSlug}`);
    }

    return {
      parsed: this.uriForKey(`${projectSlug}/parsed`),
      raw: this.uriForKey(`${projectSlug}/raw`),
      reports: this.uriForKey(`${projectSlug}/reports`),
    };
  }

  uriForRelativePath(path: string): string {
    return this.uriForKey(this.normalizeKey(path));
  }

  private bucket() {
    return this.storage.bucket(this.bucketName);
  }

  private fileForUri(uri: string) {
    return this.bucket().file(this.keyForUri(uri));
  }

  private keyForUri(uri: string): string {
    if (uri.startsWith('gs://')) {
      const withoutScheme = uri.slice('gs://'.length);
      const slashIndex = withoutScheme.indexOf('/');
      const bucket = slashIndex === -1 ? withoutScheme : withoutScheme.slice(0, slashIndex);
      const key = slashIndex === -1 ? '' : withoutScheme.slice(slashIndex + 1);
      if (bucket !== this.bucketName) {
        throw new Error(`GCS bucket mismatch: expected ${this.bucketName}, got ${bucket}`);
      }
      return this.normalizeKey(key);
    }

    return this.normalizeKey(uri);
  }

  private normalizeKey(value: string): string {
    const key = value.replace(/^\/+/, '');
    if (!key) {
      return '';
    }

    const segments = key.split('/');
    if (segments.some((segment) => segment === '..')) {
      throw new Error(`Storage path escapes bucket prefix: ${value}`);
    }

    return posix.normalize(key).replace(/^\.\//, '');
  }

  private uriForKey(key: string): string {
    return `gs://${this.bucketName}/${this.normalizeKey(key)}`;
  }
}
