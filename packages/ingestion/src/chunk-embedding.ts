import {
  DEFAULT_DETERMINISTIC_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
} from './embedding-client.js';

export {
  createGeminiEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  DEFAULT_DETERMINISTIC_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  type EmbeddingProvider,
  GEMINI_EMBEDDING_BATCH_SIZE,
  OPENAI_EMBEDDING_BATCH_SIZE,
  validateGeminiEmbeddingConfig,
  validateOpenAIEmbeddingConfig,
} from './embedding-client.js';

import { createHash } from 'node:crypto';
import { readGitHubDocumentLifecycle } from './github-lifecycle.js';
import type { ParsedDocument, ParsedDocumentType } from './ingestion-fixtures.js';
import { sha256Hex, validateParsedDocument } from './ingestion-fixtures.js';

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxCharacters: 1200,
  overlapCharacters: 120,
  version: 'chunk-v1',
};
export interface ChunkConfig {
  maxCharacters: number;
  overlapCharacters: number;
  version: string;
}

export interface ChunkEmbeddingProjectRecord {
  id: string;
  slug: string;
}

export interface ChunkEmbeddingTarget {
  logicalSourceId: string;
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

interface DocumentChunkSignature {
  chunkIndex: number;
  contentHash: string;
  embeddingModel: string;
}

export interface UpsertDocumentInput {
  canonicalUri: string;
  docType: ParsedDocumentType;
  graphNodeId: string;
  logicalSourceId: string;
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
  document: UpsertDocumentInput;
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
  activateDocumentVersion(input: {
    document: UpsertDocumentInput;
    documentId: string;
  }): Promise<boolean>;
  listCurrentChunks(input: {
    documentId: string;
    projectId: string;
  }): Promise<DocumentChunkRecord[]>;
  lookupProjectBySlug(slug: string): Promise<ChunkEmbeddingProjectRecord | undefined>;
  readParsedDocuments(input: { limit: number; projectId: string }): Promise<ChunkEmbeddingTarget[]>;
  replaceDocumentChunks(input: ReplaceDocumentChunksInput): Promise<boolean>;
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
    }
  | {
      chunkCount: number;
      decision: 'superseded';
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
    contentHash: chunkContentHash(content, index),
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
  const nextSignatures = chunkSignatures(contents, input.embeddingProvider.model);

  if (input.dryRun) {
    return {
      chunkCount: nextSignatures.length,
      decision: 'dry_run',
      rawDocumentId: input.target.rawDocumentId,
      sourceId: parsed.sourceId,
    };
  }

  const documentInput: UpsertDocumentInput = {
    canonicalUri: parsed.canonicalUri,
    docType: parsed.docType,
    graphNodeId: documentGraphNodeId(parsed),
    logicalSourceId: input.target.logicalSourceId,
    metadata: documentMetadata(input.target, parsed),
    occurredAt: parsed.occurredAt,
    projectId: input.projectId,
    rawDocumentId: input.target.rawDocumentId,
    summary: summarizeText(parsed.bodyText),
    title: parsed.title,
  };
  const document = await input.repository.upsertDocument(documentInput);
  const existingChunks = await input.repository.listCurrentChunks({
    documentId: document.id,
    projectId: input.projectId,
  });

  if (chunksMatch(existingChunks, nextSignatures)) {
    const activated = await input.repository.activateDocumentVersion({
      document: documentInput,
      documentId: document.id,
    });
    if (!activated) {
      return {
        chunkCount: nextSignatures.length,
        decision: 'superseded',
        documentId: document.id,
        rawDocumentId: input.target.rawDocumentId,
        sourceId: parsed.sourceId,
      };
    }
    return {
      chunkCount: nextSignatures.length,
      decision: 'unchanged',
      documentId: document.id,
      rawDocumentId: input.target.rawDocumentId,
      sourceId: parsed.sourceId,
    };
  }

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

  const replaced = await input.repository.replaceDocumentChunks({
    archiveReason: archiveReason(existingChunks, chunks, input.embeddingProvider.model),
    chunks,
    document: documentInput,
    documentId: document.id,
    projectId: input.projectId,
    rawDocumentId: input.target.rawDocumentId,
    supersededByContentHash: input.target.rawContentHash,
  });
  if (!replaced) {
    return {
      chunkCount: chunks.length,
      decision: 'superseded',
      documentId: document.id,
      rawDocumentId: input.target.rawDocumentId,
      sourceId: parsed.sourceId,
    };
  }

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
  if (normalized === '') {
    return [];
  }
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
  const chunkText = text.slice(start, hardEnd);
  const relativeMinimumBreak = Math.floor(maxCharacters / 2);
  const paragraphBreak = chunkText.lastIndexOf('\n\n');
  if (paragraphBreak >= relativeMinimumBreak) {
    return start + paragraphBreak;
  }
  const sentenceBreak = Math.max(
    chunkText.lastIndexOf('. '),
    chunkText.lastIndexOf('。'),
    chunkText.lastIndexOf('\n'),
  );
  if (sentenceBreak >= relativeMinimumBreak) {
    return start + sentenceBreak + 1;
  }
  const spaceBreak = chunkText.lastIndexOf(' ');
  return spaceBreak >= relativeMinimumBreak ? start + spaceBreak : hardEnd;
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
  const githubLifecycle = readGitHubDocumentLifecycle(parsed.metadata);

  return {
    parser: {
      artifactHash: target.parserArtifactHash ?? parserMetadata.artifactHash,
      parserVersionId: target.parserVersionId ?? parserMetadata.parserVersionId,
    },
    sourceId: parsed.sourceId,
    sourceType: parsed.sourceType,
    ...(githubLifecycle ? { githubLifecycle } : {}),
  };
}

function documentGraphNodeId(parsed: ParsedDocument): string {
  return `document:${parsed.docType}:${encodeURIComponent(parsed.sourceId)}`;
}

function parseTargetDocument(value: ParsedDocument | string): ParsedDocument {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as ParsedDocument) : value;
  return validateParsedDocument(parsed);
}

function chunkSignatures(
  contents: readonly string[],
  embeddingModel: string,
): DocumentChunkSignature[] {
  return contents.map((content, index) => ({
    chunkIndex: index,
    contentHash: chunkContentHash(content, index),
    embeddingModel,
  }));
}

function chunkContentHash(content: string, chunkIndex: number): string {
  return sha256Hex(`${chunkIndex}\0${content}`);
}

function summarizeText(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized === '' ? undefined : normalized.slice(0, 240);
}

function chunksMatch(existing: DocumentChunkRecord[], next: DocumentChunkSignature[]): boolean {
  if (existing.length !== next.length) {
    return false;
  }
  const sortedExisting = [...existing].sort((left, right) => left.chunkIndex - right.chunkIndex);
  return next.every((chunk, index) => {
    const current = sortedExisting[index];
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
