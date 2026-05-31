import { createHash } from 'node:crypto';
import type { ParsedDocument, ParsedDocumentType } from './ingestion-fixtures.js';
import { sha256Hex, validateParsedDocument } from './ingestion-fixtures.js';

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxCharacters: 1200,
  overlapCharacters: 120,
  version: 'chunk-v1',
};
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_DETERMINISTIC_EMBEDDING_MODEL = 'deterministic-sha256-v1';
export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

export interface ChunkConfig {
  maxCharacters: number;
  overlapCharacters: number;
  version: string;
}

export interface EmbeddingProvider {
  dimensions: number;
  embedTexts(texts: string[]): Promise<number[][]>;
  model: string;
  provider: 'deterministic' | 'gemini';
}

export interface ChunkEmbeddingProjectRecord {
  id: string;
  slug: string;
}

export interface ChunkEmbeddingTarget {
  parsed: ParsedDocument | string;
  parsedUri?: string;
  parserArtifactHash?: string;
  parserVersionId?: string;
  rawContentHash: string;
  rawDocumentId: string;
}

export interface DocumentRecord {
  docType: ParsedDocumentType;
  graphNodeId: string;
  id: string;
  projectId: string;
  rawDocumentId: string;
}

export interface DocumentChunkRecord {
  chunkIndex: number;
  contentHash: string;
  embeddingModel: string;
  id: string;
}

export interface UpsertDocumentInput {
  canonicalUri: string;
  docType: ParsedDocumentType;
  graphNodeId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  projectId: string;
  rawDocumentId: string;
  summary?: string;
  title: string;
}

export interface ReplaceDocumentChunksInput {
  archiveReason: ChunkArchiveReason;
  chunks: PreparedDocumentChunk[];
  documentId: string;
  projectId: string;
  rawDocumentId: string;
  supersededByContentHash: string;
}

export type ChunkArchiveReason =
  | 'chunk_config_changed'
  | 'document_updated'
  | 'embedding_model_changed'
  | 'manual_reindex'
  | 'parser_changed';

export interface PreparedDocumentChunk {
  chunkIndex: number;
  content: string;
  contentHash: string;
  embedding: number[];
  embeddingModel: string;
  metadata: Record<string, unknown>;
}

export interface ChunkEmbeddingRepository {
  listCurrentChunks(input: {
    documentId: string;
    projectId: string;
  }): Promise<DocumentChunkRecord[]>;
  lookupProjectBySlug(slug: string): Promise<ChunkEmbeddingProjectRecord | undefined>;
  readParsedDocuments(input: { limit: number; projectId: string }): Promise<ChunkEmbeddingTarget[]>;
  replaceDocumentChunks(input: ReplaceDocumentChunksInput): Promise<void>;
  upsertDocument(input: UpsertDocumentInput): Promise<DocumentRecord>;
}

export interface ChunkAndEmbedOptions {
  chunkConfig?: ChunkConfig;
  dryRun?: boolean;
  embeddingProvider: EmbeddingProvider;
  limit: number;
  projectSlug: string;
  repository: ChunkEmbeddingRepository;
}

export interface ChunkAndEmbedResult {
  decisions: ChunkAndEmbedDecision[];
  embeddingModel: string;
  projectSlug: string;
}

export type ChunkAndEmbedDecision =
  | {
      chunkCount: number;
      decision: 'dry_run';
      rawDocumentId: string;
      sourceId: string;
    }
  | {
      chunkCount: number;
      decision: 'indexed';
      documentId: string;
      rawDocumentId: string;
      sourceId: string;
    }
  | {
      chunkCount: number;
      decision: 'unchanged';
      documentId: string;
      rawDocumentId: string;
      sourceId: string;
    };

export async function chunkAndEmbed(options: ChunkAndEmbedOptions): Promise<ChunkAndEmbedResult> {
  const chunkConfig = normalizeChunkConfig(options.chunkConfig ?? DEFAULT_CHUNK_CONFIG);
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const targets = await options.repository.readParsedDocuments({
    limit: options.limit,
    projectId: project.id,
  });
  const decisions: ChunkAndEmbedDecision[] = [];

  for (const target of targets) {
    decisions.push(
      await chunkAndEmbedTarget({
        chunkConfig,
        dryRun: options.dryRun ?? false,
        embeddingProvider: options.embeddingProvider,
        projectId: project.id,
        repository: options.repository,
        target,
      }),
    );
  }

  return {
    decisions,
    embeddingModel: options.embeddingProvider.model,
    projectSlug: project.slug,
  };
}

export function createDeterministicEmbeddingProvider(
  input: { dimensions?: number; model?: string } = {},
): EmbeddingProvider {
  const dimensions = input.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Embedding dimensions must be a positive integer: ${dimensions}`);
  }
  const model = input.model ?? DEFAULT_DETERMINISTIC_EMBEDDING_MODEL;

  return {
    dimensions,
    model,
    provider: 'deterministic',
    async embedTexts(texts) {
      return texts.map((text) => deterministicVector({ dimensions, model, text }));
    },
  };
}

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
      const response = await fetchImpl(`${endpoint}?key=${encodeURIComponent(input.apiKey)}`, {
        body: JSON.stringify({
          requests: texts.map((text) => ({
            content: { parts: [{ text }] },
            model: geminiModelPath(input.model),
            outputDimensionality: input.dimensions,
          })),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`Gemini embedding request failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        embeddings?: Array<{ values?: number[] }>;
      };
      const vectors = body.embeddings?.map((embedding) => embedding.values ?? []) ?? [];
      validateEmbeddingVectors(vectors, input.dimensions, input.model);
      return vectors;
    },
  };
}

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

export async function checkEmbeddingProvider(input: {
  dimensions: number;
  provider: EmbeddingProvider;
  sampleText?: string;
}): Promise<{
  dimensions: number;
  model: string;
  ok: true;
  provider: EmbeddingProvider['provider'];
}> {
  const vectors = await input.provider.embedTexts([
    input.sampleText ?? 'Pufu Lens embedding check',
  ]);
  validateEmbeddingVectors(vectors, input.dimensions, input.provider.model);
  return {
    dimensions: vectors[0]?.length ?? 0,
    model: input.provider.model,
    ok: true,
    provider: input.provider.provider,
  };
}

export function prepareDocumentChunks(input: {
  chunkConfig?: ChunkConfig;
  embeddingModel: string;
  embeddings: number[][];
  parsed: ParsedDocument;
  rawContentHash: string;
}): PreparedDocumentChunk[] {
  const chunkConfig = normalizeChunkConfig(input.chunkConfig ?? DEFAULT_CHUNK_CONFIG);
  const textChunks = splitTextIntoChunks(documentText(input.parsed), chunkConfig);
  if (textChunks.length !== input.embeddings.length) {
    throw new Error(
      `Embedding count mismatch: chunks=${textChunks.length}, embeddings=${input.embeddings.length}`,
    );
  }

  return textChunks.map((content, index) => ({
    chunkIndex: index,
    content,
    contentHash: sha256Hex(content),
    embedding: input.embeddings[index] ?? [],
    embeddingModel: input.embeddingModel,
    metadata: {
      chunk: {
        maxCharacters: chunkConfig.maxCharacters,
        overlapCharacters: chunkConfig.overlapCharacters,
        version: chunkConfig.version,
      },
      rawContentHash: input.rawContentHash,
      sourceId: input.parsed.sourceId,
      sourceType: input.parsed.sourceType,
    },
  }));
}

async function chunkAndEmbedTarget(input: {
  chunkConfig: ChunkConfig;
  dryRun: boolean;
  embeddingProvider: EmbeddingProvider;
  projectId: string;
  repository: ChunkEmbeddingRepository;
  target: ChunkEmbeddingTarget;
}): Promise<ChunkAndEmbedDecision> {
  const parsed = parseTargetDocument(input.target.parsed);
  const contents = splitTextIntoChunks(documentText(parsed), input.chunkConfig);
  const embeddings = await input.embeddingProvider.embedTexts(contents);
  validateEmbeddingVectors(
    embeddings,
    input.embeddingProvider.dimensions,
    input.embeddingProvider.model,
  );
  const chunks = prepareDocumentChunks({
    chunkConfig: input.chunkConfig,
    embeddingModel: input.embeddingProvider.model,
    embeddings,
    parsed,
    rawContentHash: input.target.rawContentHash,
  });

  if (input.dryRun) {
    return {
      chunkCount: chunks.length,
      decision: 'dry_run',
      rawDocumentId: input.target.rawDocumentId,
      sourceId: parsed.sourceId,
    };
  }

  const document = await input.repository.upsertDocument({
    canonicalUri: parsed.canonicalUri,
    docType: parsed.docType,
    graphNodeId: documentGraphNodeId(parsed),
    metadata: documentMetadata(input.target, parsed),
    occurredAt: parsed.occurredAt,
    projectId: input.projectId,
    rawDocumentId: input.target.rawDocumentId,
    summary: summarizeText(parsed.bodyText),
    title: parsed.title,
  });
  const existingChunks = await input.repository.listCurrentChunks({
    documentId: document.id,
    projectId: input.projectId,
  });

  if (chunksMatch(existingChunks, chunks)) {
    return {
      chunkCount: chunks.length,
      decision: 'unchanged',
      documentId: document.id,
      rawDocumentId: input.target.rawDocumentId,
      sourceId: parsed.sourceId,
    };
  }

  await input.repository.replaceDocumentChunks({
    archiveReason: archiveReason(existingChunks, chunks, input.embeddingProvider.model),
    chunks,
    documentId: document.id,
    projectId: input.projectId,
    rawDocumentId: input.target.rawDocumentId,
    supersededByContentHash: input.target.rawContentHash,
  });

  return {
    chunkCount: chunks.length,
    decision: 'indexed',
    documentId: document.id,
    rawDocumentId: input.target.rawDocumentId,
    sourceId: parsed.sourceId,
  };
}

function deterministicVector(input: { dimensions: number; model: string; text: string }): number[] {
  const values: number[] = [];
  for (let index = 0; index < input.dimensions; index += 1) {
    const digest = createHash('sha256')
      .update(input.model)
      .update('\0')
      .update(input.text)
      .update('\0')
      .update(String(index))
      .digest();
    values.push((digest.readUInt32BE(0) / 0xffffffff) * 2 - 1);
  }
  const norm = Math.hypot(...values);
  return values.map((value) => Number((value / norm).toFixed(8)));
}

function documentText(parsed: ParsedDocument): string {
  const text = [parsed.title, parsed.bodyText].filter(Boolean).join('\n\n').trim();
  return text === '' ? parsed.title : text;
}

function splitTextIntoChunks(text: string, config: ChunkConfig): string[] {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (normalized.length <= config.maxCharacters) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + config.maxCharacters, normalized.length);
    const end =
      hardEnd === normalized.length
        ? hardEnd
        : softBreakIndex(normalized, start, hardEnd, config.maxCharacters);
    chunks.push(normalized.slice(start, end).trim());
    if (end === normalized.length) {
      break;
    }
    start = Math.max(start + 1, end - config.overlapCharacters);
    while (start < normalized.length && /\s/.test(normalized[start] ?? '')) {
      start += 1;
    }
  }
  return chunks.filter((chunk) => chunk !== '');
}

function softBreakIndex(
  text: string,
  start: number,
  hardEnd: number,
  maxCharacters: number,
): number {
  const minimumBreak = start + Math.floor(maxCharacters / 2);
  const paragraphBreak = text.lastIndexOf('\n\n', hardEnd);
  if (paragraphBreak >= minimumBreak) {
    return paragraphBreak;
  }
  const sentenceBreak = Math.max(
    text.lastIndexOf('. ', hardEnd),
    text.lastIndexOf('。', hardEnd),
    text.lastIndexOf('\n', hardEnd),
  );
  if (sentenceBreak >= minimumBreak) {
    return sentenceBreak + 1;
  }
  const spaceBreak = text.lastIndexOf(' ', hardEnd);
  return spaceBreak >= minimumBreak ? spaceBreak : hardEnd;
}

function normalizeChunkConfig(config: ChunkConfig): ChunkConfig {
  if (!Number.isInteger(config.maxCharacters) || config.maxCharacters <= 0) {
    throw new Error(`chunk maxCharacters must be a positive integer: ${config.maxCharacters}`);
  }
  if (!Number.isInteger(config.overlapCharacters) || config.overlapCharacters < 0) {
    throw new Error(
      `chunk overlapCharacters must be zero or positive: ${config.overlapCharacters}`,
    );
  }
  if (config.overlapCharacters >= config.maxCharacters) {
    throw new Error('chunk overlapCharacters must be smaller than maxCharacters.');
  }
  if (config.version.trim() === '') {
    throw new Error('chunk config version is required.');
  }
  return config;
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

function documentMetadata(
  target: ChunkEmbeddingTarget,
  parsed: ParsedDocument,
): Record<string, unknown> {
  const parserMetadata =
    typeof parsed.metadata.parser === 'object' && parsed.metadata.parser !== null
      ? (parsed.metadata.parser as Record<string, unknown>)
      : {};

  return {
    parser: {
      artifactHash: target.parserArtifactHash ?? parserMetadata.artifactHash,
      parserVersionId: target.parserVersionId ?? parserMetadata.parserVersionId,
    },
    sourceId: parsed.sourceId,
    sourceType: parsed.sourceType,
  };
}

function documentGraphNodeId(parsed: ParsedDocument): string {
  return `document:${parsed.docType}:${encodeURIComponent(parsed.sourceId)}`;
}

function parseTargetDocument(value: ParsedDocument | string): ParsedDocument {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as ParsedDocument) : value;
  return validateParsedDocument(parsed);
}

function summarizeText(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized === '' ? undefined : normalized.slice(0, 240);
}

function chunksMatch(existing: DocumentChunkRecord[], next: PreparedDocumentChunk[]): boolean {
  if (existing.length !== next.length) {
    return false;
  }
  return next.every((chunk, index) => {
    const current = existing[index];
    return (
      current?.chunkIndex === chunk.chunkIndex &&
      current.contentHash === chunk.contentHash &&
      current.embeddingModel === chunk.embeddingModel
    );
  });
}

function archiveReason(
  existing: DocumentChunkRecord[],
  next: PreparedDocumentChunk[],
  embeddingModel: string,
): ChunkArchiveReason {
  if (existing.length === 0) {
    return 'document_updated';
  }
  if (existing.some((chunk) => chunk.embeddingModel !== embeddingModel)) {
    return 'embedding_model_changed';
  }
  if (existing.length !== next.length) {
    return 'document_updated';
  }
  return 'document_updated';
}

function geminiModelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}
