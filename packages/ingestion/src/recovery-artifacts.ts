import { createHash } from 'node:crypto';
import type { GraphEdgeInput, GraphEmailQuoteInput, GraphNodeInput } from './graph-relations.js';
import type { ParsedDocumentType, SourceType } from './ingestion-fixtures.js';

export const RECOVERY_ARTIFACT_VERSION = 1;

export type RecoveryArtifactKind = 'graph-relation' | 'parsed-document' | 'raw-document';

export interface RecoveryArtifactStorage {
  getText(uri: string): Promise<string>;
  list(prefix: string): AsyncIterable<{ uri: string }>;
  put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    opts?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<{ etag?: string; uri: string }>;
}

export interface RecoveryArtifactBaseEvent {
  artifactKind: RecoveryArtifactKind;
  artifactVersion: typeof RECOVERY_ARTIFACT_VERSION;
  contentHash: string;
  projectSlug: string;
  recordedAt: string;
  sourceId: string;
  sourceType: SourceType;
}

export interface RawRecoveryArtifactEvent extends RecoveryArtifactBaseEvent {
  artifactKind: 'raw-document';
  byteSize?: number;
  dataSourceKeys?: string[];
  fetchedAt?: string;
  metadata: Record<string, unknown>;
  mimeType?: string;
  sourceUri?: string;
  storageUri: string;
}

export interface ParsedRecoveryArtifactEvent extends RecoveryArtifactBaseEvent {
  artifactKind: 'parsed-document';
  parsedAt: string;
  parsedSchemaVersion: number;
  parsedUri: string;
  parserArtifactHash: string;
  parserProfileKey: string;
  parserVersion: string;
  rawStorageUri: string;
  sourceParserProfileId?: string;
  sourceParserVersionId?: string;
}

export interface RecoveryArtifactDocumentSnapshot {
  canonicalUri: string;
  docType: ParsedDocumentType;
  metadata: Record<string, unknown>;
  occurredAt: string;
  summary?: string;
  title: string;
}

export interface GraphRecoveryArtifactEvent extends RecoveryArtifactBaseEvent {
  artifactKind: 'graph-relation';
  document: RecoveryArtifactDocumentSnapshot;
  documentGraphNodeId: string;
  edges: GraphEdgeInput[];
  emailQuotes: GraphEmailQuoteInput[];
  nodes: GraphNodeInput[];
}

export type RecoveryArtifactEvent =
  | GraphRecoveryArtifactEvent
  | ParsedRecoveryArtifactEvent
  | RawRecoveryArtifactEvent;

export interface RecoveryArtifactLatestPointer {
  artifactKind: RecoveryArtifactKind;
  artifactVersion: typeof RECOVERY_ARTIFACT_VERSION;
  eventCount: number;
  generatedAt: string;
  projectSlug: string;
  sha256: string;
}

const EVENT_PREFIX_BY_KIND: Record<RecoveryArtifactKind, string> = {
  'graph-relation': 'graph/relations/events',
  'parsed-document': 'manifests/parsed-documents/events',
  'raw-document': 'manifests/raw-documents/events',
};

const LATEST_URI_BY_KIND: Record<RecoveryArtifactKind, string> = {
  'graph-relation': 'graph/relations/latest.json',
  'parsed-document': 'manifests/parsed-documents/latest.json',
  'raw-document': 'manifests/raw-documents/latest.json',
};

export function recoveryArtifactEventPrefix(input: {
  artifactKind: RecoveryArtifactKind;
  projectSlug: string;
}): string {
  return `${input.projectSlug}/${EVENT_PREFIX_BY_KIND[input.artifactKind]}`;
}

export function recoveryArtifactLatestUri(input: {
  artifactKind: RecoveryArtifactKind;
  projectSlug: string;
}): string {
  return `${input.projectSlug}/${LATEST_URI_BY_KIND[input.artifactKind]}`;
}

export function recoveryArtifactEventUri(event: RecoveryArtifactEvent): string {
  const prefix = recoveryArtifactEventPrefix({
    artifactKind: event.artifactKind,
    projectSlug: event.projectSlug,
  });
  const key =
    event.artifactKind === 'graph-relation'
      ? event.documentGraphNodeId
      : `${event.sourceType}:${event.sourceId}`;
  const recordedAt = event.recordedAt.replace(/[^0-9A-Za-z]/g, '');
  const sourceIdHash = sha256Hex(key).slice(0, 16);
  const contentHashPrefix = event.contentHash.slice(0, 16);
  return `${prefix}/${recordedAt}-${event.sourceType}-${sourceIdHash}-${contentHashPrefix}.json`;
}

export async function writeRecoveryArtifactEvent(
  storage: RecoveryArtifactStorage,
  event: RecoveryArtifactEvent,
): Promise<{ uri: string }> {
  validateRecoveryArtifactEvent(event);
  const uri = recoveryArtifactEventUri(event);
  const stored = await storage.put(uri, `${JSON.stringify(event, null, 2)}\n`, {
    contentType: 'application/json',
    metadata: {
      artifactKind: event.artifactKind,
      artifactVersion: String(event.artifactVersion),
      projectSlug: event.projectSlug,
    },
  });
  return { uri: stored.uri };
}

export async function readRecoveryArtifactEvent(
  storage: RecoveryArtifactStorage,
  uri: string,
): Promise<RecoveryArtifactEvent> {
  const value = parseJsonObject(await storage.getText(uri), uri);
  return validateRecoveryArtifactEvent(value);
}

export async function listRecoveryArtifactEvents(
  storage: RecoveryArtifactStorage,
  input: { artifactKind: RecoveryArtifactKind; projectSlug: string },
): Promise<RecoveryArtifactEvent[]> {
  const prefix = recoveryArtifactEventPrefix(input);
  const uris: string[] = [];
  for await (const object of storage.list(prefix)) {
    if (object.uri.endsWith('.json')) {
      uris.push(object.uri);
    }
  }
  const events = await Promise.all(
    uris.map(async (uri) => {
      const event = await readRecoveryArtifactEvent(storage, uri);
      if (event.artifactKind !== input.artifactKind || event.projectSlug !== input.projectSlug) {
        throw new Error(`Recovery artifact event does not match list prefix: ${uri}`);
      }
      return event;
    }),
  );
  return events.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export async function writeRecoveryArtifactLatestPointer(
  storage: RecoveryArtifactStorage,
  pointer: RecoveryArtifactLatestPointer,
): Promise<{ uri: string }> {
  validateRecoveryArtifactLatestPointer(pointer);
  const uri = recoveryArtifactLatestUri(pointer);
  const stored = await storage.put(uri, `${JSON.stringify(pointer, null, 2)}\n`, {
    contentType: 'application/json',
    metadata: {
      artifactKind: pointer.artifactKind,
      artifactVersion: String(pointer.artifactVersion),
      projectSlug: pointer.projectSlug,
    },
  });
  return { uri: stored.uri };
}

export async function readRecoveryArtifactLatestPointer(
  storage: RecoveryArtifactStorage,
  input: { artifactKind: RecoveryArtifactKind; projectSlug: string },
): Promise<RecoveryArtifactLatestPointer> {
  const uri = recoveryArtifactLatestUri(input);
  const value = parseJsonObject(await storage.getText(uri), uri);
  const pointer = validateRecoveryArtifactLatestPointer(value);
  if (pointer.artifactKind !== input.artifactKind || pointer.projectSlug !== input.projectSlug) {
    throw new Error(`Recovery artifact latest pointer does not match URI: ${uri}`);
  }
  return pointer;
}

export function recoveryArtifactEventsSha256(events: readonly RecoveryArtifactEvent[]): string {
  const canonicalLines = events
    .map((event) => JSON.stringify(sortJsonObject(event)))
    .sort()
    .join('\n');
  return sha256Hex(canonicalLines);
}

export function validateRecoveryArtifactEvent(value: unknown): RecoveryArtifactEvent {
  const event = requireRecord(value, 'Recovery artifact event');
  const artifactKind = requireArtifactKind(event.artifactKind);
  validateBaseEvent(event, artifactKind);

  switch (artifactKind) {
    case 'graph-relation':
      return validateGraphRecoveryEvent(event);
    case 'parsed-document':
      return validateParsedRecoveryEvent(event);
    case 'raw-document':
      return validateRawRecoveryEvent(event);
  }
}

export function validateRecoveryArtifactLatestPointer(
  value: unknown,
): RecoveryArtifactLatestPointer {
  const pointer = requireRecord(value, 'Recovery artifact latest pointer');
  const artifactKind = requireArtifactKind(pointer.artifactKind);
  requireArtifactVersion(pointer.artifactVersion);
  const eventCount = requireNumber(pointer.eventCount, 'eventCount');
  if (!Number.isInteger(eventCount) || eventCount < 0) {
    throw new Error('Recovery artifact latest pointer eventCount must be a non-negative integer.');
  }
  return {
    artifactKind,
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    eventCount,
    generatedAt: requireIsoDate(pointer.generatedAt, 'generatedAt'),
    projectSlug: requireNonEmptyString(pointer.projectSlug, 'projectSlug'),
    sha256: requireSha256(pointer.sha256, 'sha256'),
  };
}

function validateRawRecoveryEvent(event: Record<string, unknown>): RawRecoveryArtifactEvent {
  return {
    artifactKind: 'raw-document',
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    byteSize: optionalNonNegativeInteger(event.byteSize, 'byteSize'),
    contentHash: requireSha256(event.contentHash, 'contentHash'),
    dataSourceKeys: optionalStringArray(event.dataSourceKeys, 'dataSourceKeys'),
    fetchedAt: optionalIsoDate(event.fetchedAt, 'fetchedAt'),
    metadata: requireRecord(event.metadata, 'metadata'),
    mimeType: optionalString(event.mimeType, 'mimeType'),
    projectSlug: requireNonEmptyString(event.projectSlug, 'projectSlug'),
    recordedAt: requireIsoDate(event.recordedAt, 'recordedAt'),
    sourceId: requireNonEmptyString(event.sourceId, 'sourceId'),
    sourceType: requireSourceType(event.sourceType),
    sourceUri: optionalString(event.sourceUri, 'sourceUri'),
    storageUri: requireNonEmptyString(event.storageUri, 'storageUri'),
  };
}

function validateParsedRecoveryEvent(event: Record<string, unknown>): ParsedRecoveryArtifactEvent {
  return {
    artifactKind: 'parsed-document',
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    contentHash: requireSha256(event.contentHash, 'contentHash'),
    parsedAt: requireIsoDate(event.parsedAt, 'parsedAt'),
    parsedSchemaVersion: requirePositiveInteger(event.parsedSchemaVersion, 'parsedSchemaVersion'),
    parsedUri: requireNonEmptyString(event.parsedUri, 'parsedUri'),
    parserArtifactHash: requireSha256(event.parserArtifactHash, 'parserArtifactHash'),
    parserProfileKey: requireNonEmptyString(event.parserProfileKey, 'parserProfileKey'),
    parserVersion: requireNonEmptyString(event.parserVersion, 'parserVersion'),
    projectSlug: requireNonEmptyString(event.projectSlug, 'projectSlug'),
    rawStorageUri: requireNonEmptyString(event.rawStorageUri, 'rawStorageUri'),
    recordedAt: requireIsoDate(event.recordedAt, 'recordedAt'),
    sourceId: requireNonEmptyString(event.sourceId, 'sourceId'),
    sourceParserProfileId: optionalString(event.sourceParserProfileId, 'sourceParserProfileId'),
    sourceParserVersionId: optionalString(event.sourceParserVersionId, 'sourceParserVersionId'),
    sourceType: requireSourceType(event.sourceType),
  };
}

function validateGraphRecoveryEvent(event: Record<string, unknown>): GraphRecoveryArtifactEvent {
  return {
    artifactKind: 'graph-relation',
    artifactVersion: RECOVERY_ARTIFACT_VERSION,
    contentHash: requireSha256(event.contentHash, 'contentHash'),
    document: validateDocumentSnapshot(event.document),
    documentGraphNodeId: requireNonEmptyString(event.documentGraphNodeId, 'documentGraphNodeId'),
    edges: requireArray(event.edges, 'edges').map((edge, index) =>
      validateGraphEdge(edge, `edges[${index}]`),
    ),
    emailQuotes: requireArray(event.emailQuotes, 'emailQuotes').map((quote, index) =>
      validateEmailQuote(quote, `emailQuotes[${index}]`),
    ),
    nodes: requireArray(event.nodes, 'nodes').map((node, index) =>
      validateGraphNode(node, `nodes[${index}]`),
    ),
    projectSlug: requireNonEmptyString(event.projectSlug, 'projectSlug'),
    recordedAt: requireIsoDate(event.recordedAt, 'recordedAt'),
    sourceId: requireNonEmptyString(event.sourceId, 'sourceId'),
    sourceType: requireSourceType(event.sourceType),
  };
}

function validateBaseEvent(event: Record<string, unknown>, artifactKind: RecoveryArtifactKind) {
  if (event.artifactKind !== artifactKind) {
    throw new Error('Recovery artifact event artifactKind is invalid.');
  }
  requireArtifactVersion(event.artifactVersion);
  requireNonEmptyString(event.projectSlug, 'projectSlug');
  requireIsoDate(event.recordedAt, 'recordedAt');
  requireSourceType(event.sourceType);
  requireNonEmptyString(event.sourceId, 'sourceId');
  requireSha256(event.contentHash, 'contentHash');
}

function validateDocumentSnapshot(value: unknown): RecoveryArtifactDocumentSnapshot {
  const document = requireRecord(value, 'document');
  const snapshot: RecoveryArtifactDocumentSnapshot = {
    canonicalUri: requireNonEmptyString(document.canonicalUri, 'document.canonicalUri'),
    docType: requireParsedDocumentType(document.docType),
    metadata: requireRecord(document.metadata, 'document.metadata'),
    occurredAt: requireIsoDate(document.occurredAt, 'document.occurredAt'),
    title: requireNonEmptyString(document.title, 'document.title'),
  };
  const summary = optionalString(document.summary, 'document.summary');
  if (summary !== undefined) {
    snapshot.summary = summary;
  }
  return snapshot;
}

function validateGraphNode(value: unknown, path: string): GraphNodeInput {
  const node = requireRecord(value, path);
  return {
    graphNodeId: requireNonEmptyString(node.graphNodeId, `${path}.graphNodeId`),
    labels: requireStringArray(node.labels, `${path}.labels`),
    properties: requireRecord(node.properties, `${path}.properties`),
  };
}

function validateGraphEdge(value: unknown, path: string): GraphEdgeInput {
  const edge = requireRecord(value, path);
  return {
    fromGraphNodeId: requireNonEmptyString(edge.fromGraphNodeId, `${path}.fromGraphNodeId`),
    properties: requireRecord(edge.properties, `${path}.properties`),
    toGraphNodeId: requireNonEmptyString(edge.toGraphNodeId, `${path}.toGraphNodeId`),
    type: requireGraphEdgeType(edge.type, `${path}.type`),
  };
}

function validateEmailQuote(value: unknown, path: string): GraphEmailQuoteInput {
  const quote = requireRecord(value, path);
  const emailQuote: GraphEmailQuoteInput = {
    bodyText: requireNonEmptyString(quote.bodyText, `${path}.bodyText`),
    quoteIndex: requirePositiveInteger(quote.quoteIndex, `${path}.quoteIndex`),
    quotedMessageId: requireNonEmptyString(quote.quotedMessageId, `${path}.quotedMessageId`),
    senderAlias: requireNonEmptyString(quote.senderAlias, `${path}.senderAlias`),
    sentAt: requireIsoDate(quote.sentAt, `${path}.sentAt`),
  };
  const prevQuoteIndex = optionalPositiveInteger(quote.prevQuoteIndex, `${path}.prevQuoteIndex`);
  if (prevQuoteIndex !== undefined) {
    emailQuote.prevQuoteIndex = prevQuoteIndex;
  }
  const senderActorId = optionalString(quote.senderActorId, `${path}.senderActorId`);
  if (senderActorId !== undefined) {
    emailQuote.senderActorId = senderActorId;
  }
  return emailQuote;
}

function parseJsonObject(text: string, uri: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(text), `Recovery artifact object ${uri}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse recovery artifact JSON at ${uri}: ${reason}`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function requireArtifactKind(value: unknown): RecoveryArtifactKind {
  if (value === 'graph-relation' || value === 'parsed-document' || value === 'raw-document') {
    return value;
  }
  throw new Error('Recovery artifact kind is invalid.');
}

function requireArtifactVersion(value: unknown): typeof RECOVERY_ARTIFACT_VERSION {
  if (value !== RECOVERY_ARTIFACT_VERSION) {
    throw new Error(`Recovery artifact version must be ${RECOVERY_ARTIFACT_VERSION}.`);
  }
  return RECOVERY_ARTIFACT_VERSION;
}

function requireSourceType(value: unknown): SourceType {
  if (value === 'drive' || value === 'github' || value === 'gmail' || value === 'web') {
    return value;
  }
  throw new Error('sourceType is invalid.');
}

function requireParsedDocumentType(value: unknown): ParsedDocumentType {
  if (
    value === 'drive_doc' ||
    value === 'email' ||
    value === 'issue' ||
    value === 'pull_request' ||
    value === 'web_page'
  ) {
    return value;
  }
  throw new Error('document.docType is invalid.');
}

function requireGraphEdgeType(value: unknown, path: string): GraphEdgeInput['type'] {
  if (
    value === 'AUTHORED' ||
    value === 'COMMENTED_ON' ||
    value === 'MENTIONS' ||
    value === 'OWNS' ||
    value === 'REPLY_TO' ||
    value === 'REVIEWED' ||
    value === 'SAME_AS' ||
    value === 'SENT'
  ) {
    return value;
  }
  throw new Error(`${path} is invalid.`);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((item, index) =>
    requireNonEmptyString(item, `${path}[${index}]`),
  );
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  return requireStringArray(value, path);
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${path} must be a number.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  const number = requireNumber(value, path);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${path} must be a positive integer.`);
  }
  return number;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  return requirePositiveInteger(value, path);
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  const number = requireNumber(value, path);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${path} must be a non-negative integer.`);
  }
  return number;
}

function requireIsoDate(value: unknown, path: string): string {
  const text = requireNonEmptyString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${path} must be an ISO date string.`);
  }
  return text;
}

function optionalIsoDate(value: unknown, path: string): string | undefined {
  if (isNullish(value)) {
    return undefined;
  }
  return requireIsoDate(value, path);
}

function requireSha256(value: unknown, path: string): string {
  const text = requireNonEmptyString(value, path);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error(`${path} must be a sha256 hex string.`);
  }
  return text;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortJsonObject(value: unknown): unknown {
  if (hasToJson(value)) {
    return sortJsonObject(value.toJSON());
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonObject(item));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonObject((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function hasToJson(value: unknown): value is { toJSON(): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  );
}

function isNullish(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}
