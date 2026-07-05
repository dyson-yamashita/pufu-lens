import { Readable } from 'node:stream';
import type { ObjectInfo, ObjectStorage } from './object-storage.ts';

async function bodyToText(body: Buffer | NodeJS.ReadableStream | string): Promise<string> {
  if (typeof body === 'string') {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, string>();
  private readonly updatedAt = new Map<string, Date>();

  constructor(objects?: ReadonlyMap<string, string>) {
    if (objects) {
      for (const [uri, text] of objects) {
        this.objects.set(uri, text);
      }
    }
  }

  async put(uri: string, body: Buffer | NodeJS.ReadableStream | string): Promise<{ uri: string }> {
    const text = await bodyToText(body);
    const storedUri = `file:///tmp/pufu-lens/${uri}`;
    this.objects.set(storedUri, text);
    this.objects.set(uri, text);
    this.updatedAt.set(storedUri, new Date(0));
    this.updatedAt.set(uri, new Date(0));
    return { uri: storedUri };
  }

  async get(uri: string): Promise<NodeJS.ReadableStream> {
    return Readable.from([await this.getText(uri)]);
  }

  async getText(uri: string): Promise<string> {
    const value = this.objects.get(uri);
    if (value === undefined) {
      throw new Error(`missing object: ${uri}`);
    }
    return value;
  }

  async exists(uri: string): Promise<boolean> {
    return this.objects.has(uri) || this.objects.has(`file:///tmp/pufu-lens/${uri}`);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    for (const [uri, text] of this.objects) {
      if (!uri.startsWith(prefix)) {
        continue;
      }
      yield {
        size: Buffer.byteLength(text),
        updatedAt: this.updatedAt.get(uri) ?? new Date(0),
        uri,
      };
    }
  }
}
