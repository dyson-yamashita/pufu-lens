import { fetchWithRetry } from './http-retry.js';

export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_DETERMINISTIC_EMBEDDING_MODEL = 'deterministic-sha256-v1';
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const GEMINI_EMBEDDING_BATCH_SIZE = 100;
export const OPENAI_EMBEDDING_BATCH_SIZE = 100;

export interface EmbeddingProvider {
  dimensions: number;
  embedTexts(texts: string[]): Promise<number[][]>;
  model: string;
  provider: 'deterministic' | 'gemini' | 'openai';
}

/** Creates the fetch-only Gemini client; batches preserve input order and enforce dimensions. */
export function createGeminiEmbeddingProvider(input: {
  apiKey: string;
  dimensions: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  model: string;
}): EmbeddingProvider {
  validateGeminiEmbeddingConfig(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint =
    input.endpoint ??
    `https://generativelanguage.googleapis.com/v1beta/${geminiModelPath(input.model)}:batchEmbedContents`;

  return {
    dimensions: input.dimensions,
    model: input.model,
    provider: 'gemini',
    async embedTexts(texts) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += GEMINI_EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(start, start + GEMINI_EMBEDDING_BATCH_SIZE);
        const response = await fetchWithRetry(
          endpoint,
          {
            body: JSON.stringify({
              requests: batch.map((text) => ({
                content: { parts: [{ text }] },
                model: geminiModelPath(input.model),
                outputDimensionality: input.dimensions,
              })),
            }),
            headers: { 'content-type': 'application/json', 'x-goog-api-key': input.apiKey },
            method: 'POST',
          },
          { fetchImpl },
        );
        if (!response.ok) {
          throw new Error(`Gemini embedding request failed: HTTP ${response.status}`);
        }
        const body = (await response.json()) as {
          embeddings?: Array<{ values?: number[] }>;
        };
        const batchVectors = body.embeddings?.map((embedding) => embedding.values ?? []) ?? [];
        validateEmbeddingCount(batchVectors, batch.length, input.model);
        validateEmbeddingVectors(batchVectors, input.dimensions, input.model);
        vectors.push(...batchVectors);
      }
      return vectors;
    },
  };
}

/**
 * Creates an OpenAI embedding adapter that preserves input ordering and the shared vector schema.
 *
 * @param input - OpenAI credentials, model, fixed dimensions, and optional test/runtime overrides
 * @returns An embedding provider whose vectors can be stored in the shared pgvector column
 * @throws When credentials, model, or dimensions do not satisfy the runtime contract
 */
export function createOpenAIEmbeddingProvider(input: {
  apiKey: string;
  dimensions: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  model: string;
}): EmbeddingProvider {
  validateOpenAIEmbeddingConfig(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = input.endpoint ?? 'https://api.openai.com/v1/embeddings';

  return {
    dimensions: input.dimensions,
    model: input.model,
    provider: 'openai',
    async embedTexts(texts) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += OPENAI_EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(start, start + OPENAI_EMBEDDING_BATCH_SIZE);
        const response = await fetchWithRetry(
          endpoint,
          {
            body: JSON.stringify({
              dimensions: input.dimensions,
              encoding_format: 'float',
              input: batch,
              model: input.model,
            }),
            headers: {
              authorization: `Bearer ${input.apiKey}`,
              'content-type': 'application/json',
            },
            method: 'POST',
          },
          { fetchImpl },
        );
        if (!response.ok) {
          throw new Error(`OpenAI embedding request failed: HTTP ${response.status}`);
        }
        const body = (await response.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };
        const batchVectors = [...(body.data ?? [])]
          .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
          .map((item) => item.embedding ?? []);
        validateEmbeddingCount(batchVectors, batch.length, input.model);
        validateEmbeddingVectors(batchVectors, input.dimensions, input.model);
        vectors.push(...batchVectors);
      }
      return vectors;
    },
  };
}

/** Rejects missing Gemini credentials/model or dimensions incompatible with the existing schema. */
export function validateGeminiEmbeddingConfig(input: {
  apiKey?: string;
  dimensions?: number;
  model?: string;
}): void {
  if (!input.apiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini embedding.');
  }
  if (!input.model) {
    throw new Error('GEMINI_EMBEDDING_MODEL is required for Gemini embedding.');
  }
  if (input.dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `GEMINI_EMBEDDING_DIMENSIONS must be ${DEFAULT_EMBEDDING_DIMENSIONS}; got ${String(
        input.dimensions,
      )}.`,
    );
  }
}

/**
 * Validates OpenAI embedding settings against the database vector contract.
 *
 * @param input - OpenAI credentials, model name, and requested output dimensions
 * @throws When a required value is missing or dimensions differ from the pgvector schema
 */
export function validateOpenAIEmbeddingConfig(input: {
  apiKey?: string;
  dimensions?: number;
  model?: string;
}): void {
  if (!input.apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI embedding.');
  }
  if (!input.model) {
    throw new Error('OPENAI_EMBEDDING_MODEL is required for OpenAI embedding.');
  }
  if (input.dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `OPENAI_EMBEDDING_DIMENSIONS must be ${DEFAULT_EMBEDDING_DIMENSIONS}; got ${String(
        input.dimensions,
      )}.`,
    );
  }
}

function validateEmbeddingVectors(vectors: number[][], dimensions: number, model: string): void {
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch for ${model} at index ${index}: expected ${dimensions}, got ${vector.length}`,
      );
    }
  }
}

function validateEmbeddingCount(vectors: number[][], expected: number, model: string): void {
  if (vectors.length !== expected) {
    throw new Error(
      `Embedding count mismatch for ${model}: expected ${expected}, got ${vectors.length}`,
    );
  }
}

function geminiModelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}
