export interface PutOptions {
  cacheControl?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface ObjectInfo {
  size: number;
  updatedAt: Date;
  uri: string;
}

export interface ObjectStorage {
  put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    opts?: PutOptions,
  ): Promise<{ etag?: string; uri: string }>;
  get(uri: string): Promise<NodeJS.ReadableStream>;
  getText(uri: string): Promise<string>;
  exists(uri: string): Promise<boolean>;
  signedUrl?(uri: string, ttlSeconds: number): Promise<string>;
  list(prefix: string): AsyncIterable<ObjectInfo>;
}

export interface ProjectStoragePrefixes {
  parsed: string;
  raw: string;
  reports: string;
}
