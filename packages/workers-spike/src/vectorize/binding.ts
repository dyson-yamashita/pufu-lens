import { record, text } from '../d1/binding.js';

/** Cloudflare-only structural API. Untrusted service responses stay unknown until parsed. */
export interface VectorizeBinding {
  describe(): Promise<unknown>;
  query(
    values: number[],
    options: {
      topK: number;
      namespace: string;
      returnMetadata: 'all';
      returnValues: false;
      filter: { projectId: string; model: string };
    },
  ): Promise<unknown>;
  upsert(vectors: Vector[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}
export interface Vector {
  id: string;
  namespace: string;
  values: number[];
  metadata: { projectId: string; model: string; revision: number };
}
export interface IndexContract {
  model: string;
  dimensions: 1536;
  metric: 'cosine';
  /** Deployment evidence from list-metadata-index, not inferred from query success. */
  indexedMetadata: readonly string[];
}

/** Rejects missing filter configuration; remote metadata-index existence needs deployment evidence. */
export async function verifyIndex(index: VectorizeBinding, config: IndexContract): Promise<void> {
  identity(config.model);
  if (
    config.dimensions !== 1536 ||
    config.metric !== 'cosine' ||
    !Array.isArray(config.indexedMetadata) ||
    !['projectId', 'model'].every((key) => config.indexedMetadata.includes(key))
  )
    throw new Error('Invalid Vectorize configuration');
  const description = record(await index.describe());
  if (description.dimensions !== 1536 || description.metric !== 'cosine')
    throw new Error('Vectorize index mismatch');
}

/** Rejects truncated metadata/namespace identities and malformed Unicode before any IO. */
export function identity(value: unknown): string {
  const result = text(value);
  if (
    new TextEncoder().encode(result).length > 64 ||
    result.includes('\0') ||
    /[\uD800-\uDFFF]/u.test(result)
  )
    throw new Error('Invalid vector identity');
  return result;
}

/** Requires a nonzero finite float32-compatible vector in the fixed 1536-dimensional model space. */
export function embedding(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 1536 ||
    !value.every(
      (v) => typeof v === 'number' && Number.isFinite(v) && Number.isFinite(Math.fround(v)),
    ) ||
    !value.some((v) => Math.fround(v) !== 0)
  )
    throw new Error('Invalid embedding');
  return value;
}

/** Hashes the project/document/revision/chunk tuple into a globally unique, immutable version ID. */
export async function vectorId(
  project: string,
  document: string,
  revision: number,
  chunk: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([project, document, revision, chunk]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
