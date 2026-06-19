import { createHash } from 'node:crypto';
import type { SourceType } from './ingestion-fixtures.js';
import {
  type ParsedDocument,
  parseRawContent,
  type RawDocumentContract,
  validateParsedDocument,
} from './ingestion-fixtures.js';
import type { TopicExtractionAgent } from './topic-extraction-agent.js';

export const PARSED_SCHEMA_VERSION = 1;
export const BUILT_IN_PARSER_ARTIFACT = JSON.stringify(
  {
    id: 'built-in-fixture-parser',
    parser: 'packages/ingestion/src/ingestion-fixtures.ts',
    schemaVersion: PARSED_SCHEMA_VERSION,
    sourceTypes: ['github', 'web', 'gmail', 'drive'],
  },
  null,
  2,
);
export const BUILT_IN_PARSER_ARTIFACT_HASH = sha256Hex(BUILT_IN_PARSER_ARTIFACT);

export type IngestionQueueStatus = 'pending' | 'parsing' | 'parsed' | 'indexed' | 'failed' | 'held';
export type RawIngestStatus = 'fetched' | 'held' | 'parsed' | 'indexed' | 'failed';
export type HoldReason = 'parser_approval_required' | 'parser_contract_mismatch';

export interface ParseObjectStorage {
  getText(uri: string): Promise<string>;
  put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    opts?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<{ etag?: string; uri: string }>;
}

export interface ParseProjectRecord {
  id: string;
  slug: string;
}

export interface ParseRawDocumentRecord {
  contentHash: string;
  id: string;
  metadata: Record<string, unknown>;
  mimeType: string;
  projectId: string;
  sourceId: string;
  sourceType: SourceType;
  sourceUri: string;
  storageUri: string;
}

export interface ParseQueueTarget {
  attempts: number;
  dataSourceId: string;
  id: string;
  projectId: string;
  rawDocument: ParseRawDocumentRecord;
}

export interface ParserVersionRecord {
  artifactHash: string;
  artifactUri?: string;
  contract: ParserVersionContract;
  id: string;
  parserProfileId: string;
  schemaVersion: number;
  sourceType: SourceType;
  status: 'draft' | 'review_requested' | 'approved' | 'retired';
  version: string;
}

export interface ParserVersionContract {
  requiredPaths?: string[];
}

export interface MarkParsedInput {
  expectedAttempts: number;
  parsedAt: string;
  parsedUri: string;
  parserArtifactHash: string;
  parserProfileId: string;
  parserVersion: string;
  parserVersionId: string;
  queueId: string;
  rawDocumentId: string;
  schemaVersion: number;
}

export interface MarkFailedInput {
  errorCode: string;
  expectedAttempts: number;
  lastError: string;
  parserProfileId?: string;
  parserVersionId?: string;
  queueId: string;
  rawDocumentId: string;
  sanitizedSampleUri?: string;
}

export interface MarkHeldInput {
  expectedAttempts: number;
  holdReason: HoldReason;
  lastError: string;
  parserProfileId?: string;
  parserVersionId?: string;
  queueId: string;
  rawDocumentId: string;
}

export interface RawParseRepository {
  dequeueTargets(input: { limit: number; projectId: string }): Promise<ParseQueueTarget[]>;
  lookupProjectBySlug(slug: string): Promise<ParseProjectRecord | undefined>;
  markFailed(input: MarkFailedInput): Promise<void>;
  markHeld(input: MarkHeldInput): Promise<void>;
  markParsed(input: MarkParsedInput): Promise<void>;
  selectActiveParserVersion(input: {
    dataSourceId: string;
    projectId: string;
    sourceType: SourceType;
  }): Promise<ParserVersionRecord | undefined>;
}

export interface ParseRawOptions {
  limit: number;
  projectSlug: string;
  repository: RawParseRepository;
  storage: ParseObjectStorage;
  topicExtractionAgent?: TopicExtractionAgent;
}

export interface ParseRawResult {
  decisions: ParseRawDecision[];
  projectSlug: string;
}

interface ParseBatchContext {
  artifactHashCache: Map<string, string>;
}

export type ParseRawDecision =
  | {
      decision: 'parsed';
      parsedUri: string;
      queueId: string;
      rawDocumentId: string;
      sourceId: string;
      sourceType: SourceType;
    }
  | {
      decision: 'held';
      holdReason: HoldReason;
      queueId: string;
      rawDocumentId: string;
      sourceId: string;
      sourceType: SourceType;
    }
  | {
      decision: 'failed';
      errorCode: string;
      queueId: string;
      rawDocumentId: string;
      sourceId: string;
      sourceType: SourceType;
    };

export async function parseRawDocuments(options: ParseRawOptions): Promise<ParseRawResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const targets = await options.repository.dequeueTargets({
    limit: options.limit,
    projectId: project.id,
  });
  const decisions: ParseRawDecision[] = [];
  const batchContext: ParseBatchContext = {
    artifactHashCache: new Map(),
  };

  for (const target of targets) {
    decisions.push(await parseQueueTarget({ ...options, batchContext, project, target }));
  }

  return { decisions, projectSlug: project.slug };
}

async function parseQueueTarget(input: {
  batchContext: ParseBatchContext;
  project: ParseProjectRecord;
  repository: RawParseRepository;
  storage: ParseObjectStorage;
  target: ParseQueueTarget;
  topicExtractionAgent?: TopicExtractionAgent;
}): Promise<ParseRawDecision> {
  const rawDocument = input.target.rawDocument;
  const parserVersion = await input.repository.selectActiveParserVersion({
    dataSourceId: input.target.dataSourceId,
    projectId: input.project.id,
    sourceType: rawDocument.sourceType,
  });

  if (!parserVersion) {
    await input.repository.markHeld({
      expectedAttempts: input.target.attempts,
      holdReason: 'parser_approval_required',
      lastError: 'No approved active parser version was found.',
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
    });
    return heldDecision(input.target, 'parser_approval_required');
  }

  let artifactHash: string;
  let rawText: string;
  try {
    artifactHash = await resolveAndVerifyArtifactHash({
      cache: input.batchContext.artifactHashCache,
      parserVersion,
      storage: input.storage,
    });
    rawText = await input.storage.getText(rawDocument.storageUri);
  } catch (error) {
    await input.repository.markFailed({
      errorCode: 'parser_artifact_or_raw_read_failed',
      expectedAttempts: input.target.attempts,
      lastError: sanitizeError(error),
      parserProfileId: parserVersion.parserProfileId,
      parserVersionId: parserVersion.id,
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
    });

    return {
      decision: 'failed',
      errorCode: 'parser_artifact_or_raw_read_failed',
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
      sourceId: rawDocument.sourceId,
      sourceType: rawDocument.sourceType,
    };
  }

  const contractResult = validateParserContract(rawText, parserVersion.contract);
  if (!contractResult.ok) {
    await input.repository.markHeld({
      expectedAttempts: input.target.attempts,
      holdReason: 'parser_contract_mismatch',
      lastError: contractResult.error,
      parserProfileId: parserVersion.parserProfileId,
      parserVersionId: parserVersion.id,
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
    });
    return heldDecision(input.target, 'parser_contract_mismatch');
  }

  try {
    const parsed = await buildParsedDocument({
      parserVersion,
      projectSlug: input.project.slug,
      rawDocument,
      rawText,
      topicExtractionAgent: input.topicExtractionAgent,
    });
    const parsedUri = parsedStorageUri(input.project.slug, rawDocument);
    const parsedBody = `${JSON.stringify(parsed, null, 2)}\n`;
    const stored = await input.storage.put(parsedUri, parsedBody, {
      contentType: 'application/json',
      metadata: {
        parserArtifactHash: artifactHash,
        parserVersionId: parserVersion.id,
        rawDocumentId: rawDocument.id,
      },
    });
    const parsedAt = new Date().toISOString();

    await input.repository.markParsed({
      expectedAttempts: input.target.attempts,
      parsedAt,
      parsedUri: stored.uri,
      parserArtifactHash: artifactHash,
      parserProfileId: parserVersion.parserProfileId,
      parserVersion: parserVersion.version,
      parserVersionId: parserVersion.id,
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
      schemaVersion: parserVersion.schemaVersion,
    });

    return {
      decision: 'parsed',
      parsedUri: stored.uri,
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
      sourceId: rawDocument.sourceId,
      sourceType: rawDocument.sourceType,
    };
  } catch (error) {
    await input.repository.markFailed({
      errorCode: 'parse_failed',
      expectedAttempts: input.target.attempts,
      lastError: sanitizeError(error),
      parserProfileId: parserVersion.parserProfileId,
      parserVersionId: parserVersion.id,
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
    });

    return {
      decision: 'failed',
      errorCode: 'parse_failed',
      queueId: input.target.id,
      rawDocumentId: rawDocument.id,
      sourceId: rawDocument.sourceId,
      sourceType: rawDocument.sourceType,
    };
  }
}

async function buildParsedDocument(input: {
  parserVersion: ParserVersionRecord;
  projectSlug: string;
  rawDocument: ParseRawDocumentRecord;
  rawText: string;
  topicExtractionAgent?: TopicExtractionAgent;
}): Promise<ParsedDocument> {
  const rawContract: RawDocumentContract = {
    contentHash: input.rawDocument.contentHash,
    metadata: input.rawDocument.metadata,
    mimeType: input.rawDocument.mimeType,
    projectSlug: input.projectSlug,
    sourceId: input.rawDocument.sourceId,
    sourceType: input.rawDocument.sourceType,
    sourceUri: input.rawDocument.sourceUri,
    storageUri: input.rawDocument.storageUri,
  };
  const parsed = validateParsedDocument(
    await parseRawContent(
      { raw: rawContract, sourceType: input.rawDocument.sourceType },
      input.rawText,
      { topicExtractionAgent: input.topicExtractionAgent },
    ),
  );

  return {
    ...parsed,
    metadata: {
      ...parsed.metadata,
      parser: {
        artifactHash: input.parserVersion.artifactHash,
        parserProfileId: input.parserVersion.parserProfileId,
        parserVersion: input.parserVersion.version,
        parserVersionId: input.parserVersion.id,
        schemaVersion: input.parserVersion.schemaVersion,
      },
    },
  };
}

export function validateParserContract(
  rawText: string,
  contract: ParserVersionContract,
): { ok: true } | { error: string; ok: false } {
  const requiredPaths = contract.requiredPaths ?? [];
  if (requiredPaths.length === 0) {
    return { ok: true };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    return { error: 'Raw document is not JSON for parser contract validation.', ok: false };
  }

  for (const requiredPath of requiredPaths) {
    if (!hasJsonPath(rawJson, requiredPath)) {
      return { error: `Raw document is missing required path: ${requiredPath}`, ok: false };
    }
  }

  return { ok: true };
}

export function defaultParserContract(sourceType: SourceType): ParserVersionContract {
  switch (sourceType) {
    case 'github':
      return { requiredPaths: ['kind', 'repository', 'number', 'title', 'html_url', 'created_at'] };
    case 'gmail':
      return { requiredPaths: ['threadId', 'messageId', 'subject', 'from.email', 'sentAt'] };
    case 'drive':
      return { requiredPaths: ['fileId', 'revisionId', 'title', 'modifiedTime', 'webViewLink'] };
    case 'web':
      return {};
  }
}

export function defaultBuiltInParserVersion(input: {
  parserProfileId: string;
  parserVersionId: string;
  sourceType: SourceType;
}): ParserVersionRecord {
  return {
    artifactHash: BUILT_IN_PARSER_ARTIFACT_HASH,
    contract: defaultParserContract(input.sourceType),
    id: input.parserVersionId,
    parserProfileId: input.parserProfileId,
    schemaVersion: PARSED_SCHEMA_VERSION,
    sourceType: input.sourceType,
    status: 'approved',
    version: 'fixture-parser-v1',
  };
}

export function parsedStorageUri(projectSlug: string, rawDocument: ParseRawDocumentRecord): string {
  return `${projectSlug}/parsed/${rawDocument.sourceType}/${safeStorageSegment(
    rawDocument.sourceId,
  )}.json`;
}

async function resolveAndVerifyArtifactHash(input: {
  cache: Map<string, string>;
  parserVersion: ParserVersionRecord;
  storage: ParseObjectStorage;
}): Promise<string> {
  const cacheKey = input.parserVersion.artifactUri ?? `built-in:${input.parserVersion.id}`;
  const cachedHash = input.cache.get(cacheKey);
  const actualHash =
    cachedHash ??
    (input.parserVersion.artifactUri
      ? sha256Hex(await input.storage.getText(input.parserVersion.artifactUri))
      : BUILT_IN_PARSER_ARTIFACT_HASH);
  input.cache.set(cacheKey, actualHash);

  if (actualHash !== input.parserVersion.artifactHash) {
    throw new Error(`Parser artifact hash mismatch: ${input.parserVersion.id}`);
  }

  return actualHash;
}

function hasJsonPath(value: unknown, path: string): boolean {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined && current !== null && current !== '';
}

function heldDecision(target: ParseQueueTarget, holdReason: HoldReason): ParseRawDecision {
  return {
    decision: 'held',
    holdReason,
    queueId: target.id,
    rawDocumentId: target.rawDocument.id,
    sourceId: target.rawDocument.sourceId,
    sourceType: target.rawDocument.sourceType,
  };
}

function safeStorageSegment(value: string): string {
  return normalizeStorageSegment(value, 160);
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactHttpUrls(
    message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'redacted@example.test'),
  ).slice(0, 500);
}

function normalizeStorageSegment(value: string, maxLength: number): string {
  let output = '';
  let lastWasDash = false;
  for (const char of value.toLowerCase()) {
    const safe = isSafeStorageChar(char);
    if (safe) {
      output += char;
      lastWasDash = false;
    } else if (!lastWasDash) {
      output += '-';
      lastWasDash = true;
    }
    if (output.length >= maxLength) {
      break;
    }
  }
  return trimDashes(output);
}

function isSafeStorageChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= '0' && char <= '9') ||
    char === '.' ||
    char === '_' ||
    char === '-'
  );
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') {
    start += 1;
  }
  while (end > start && value[end - 1] === '-') {
    end -= 1;
  }
  return value.slice(start, end);
}

function redactHttpUrls(value: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const nextHttp = nextHttpUrlStart(value, cursor);
    if (nextHttp < 0) {
      return output + value.slice(cursor);
    }
    output += value.slice(cursor, nextHttp);
    const end = urlTokenEnd(value, nextHttp);
    output += 'https://example.test/redacted';
    cursor = end;
  }
  return output;
}

function nextHttpUrlStart(value: string, fromIndex: number): number {
  const lowerValue = value.toLowerCase();
  const httpIndex = lowerValue.indexOf('http://', fromIndex);
  const httpsIndex = lowerValue.indexOf('https://', fromIndex);
  if (httpIndex < 0) {
    return httpsIndex;
  }
  if (httpsIndex < 0) {
    return httpIndex;
  }
  return Math.min(httpIndex, httpsIndex);
}

function urlTokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const char = value.charAt(index);
    if (char.trim() === '' || char === '"' || char === "'" || char === '<' || char === '>') {
      break;
    }
    index += 1;
  }
  return index;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
