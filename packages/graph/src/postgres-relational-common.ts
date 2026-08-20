import { parseGraphCountResult, requireSafeJsonValue } from './index.js';

export const GRAPH_MUTATION_UNAVAILABLE_MESSAGE = 'Graph mutation capability unavailable.';
export const GRAPH_READ_UNAVAILABLE_MESSAGE = 'Graph read capability unavailable.';

const PRIMARY_LABEL_TO_KIND = {
  Actor: 'actor',
  Document: 'document',
  Topic: 'topic',
} as const;

export type RelationalGraphNodeKind =
  (typeof PRIMARY_LABEL_TO_KIND)[keyof typeof PRIMARY_LABEL_TO_KIND];

export interface RelationalGraphNodeMappingInput {
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface RelationalGraphNodeMappingResult {
  readonly kind: RelationalGraphNodeKind;
  readonly normalizedProperties: Record<string, unknown>;
  readonly subtype: string;
}

/** Maps provider-neutral graph labels and properties onto relational node kind/subtype columns. */
export function deriveRelationalGraphNodeKindSubtype(
  input: RelationalGraphNodeMappingInput,
): RelationalGraphNodeMappingResult {
  const primaryLabel = input.labels[0];
  if (!primaryLabel || !(primaryLabel in PRIMARY_LABEL_TO_KIND)) {
    throw new Error(`Invalid graph label: ${primaryLabel ?? 'missing'}`);
  }
  const kind = PRIMARY_LABEL_TO_KIND[primaryLabel as keyof typeof PRIMARY_LABEL_TO_KIND];
  const normalizedProperties = requireSafeJsonObject(
    input.properties,
    'graph mutation node properties',
  );
  const graphNodeId = requireNonEmptyString(normalizedProperties.graphNodeId, 'graphNodeId');
  const graphLabels = input.labels.map((label) => requireNonEmptyString(label, 'label'));
  const storedProperties = {
    ...normalizedProperties,
    graphLabels,
    graphNodeId,
  };
  return {
    kind,
    normalizedProperties: storedProperties,
    subtype: deriveSubtype(kind, storedProperties),
  };
}

/** Parses a single relational SQL count row at an adapter boundary. */
export function parseRelationalIntegerField(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  throw new Error(`Invalid relational ${label}: value is not a safe integer.`);
}

export function parseRelationalCountRow(row: unknown, label: string): number {
  if (!isRecord(row)) {
    throw new Error(`Invalid relational ${label}.`);
  }
  return parseRelationalIntegerField(row.count, label);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid graph field: ${fieldName}`);
  }
  return value;
}

export function propertyString(
  properties: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function displayNodeLabel(kind: string, properties: Record<string, unknown>): string {
  return (
    propertyString(properties, 'title') ??
    propertyString(properties, 'displayName') ??
    propertyString(properties, 'display_name') ??
    propertyString(properties, 'name') ??
    propertyString(properties, 'canonicalUri') ??
    propertyString(properties, 'canonical_uri') ??
    propertyString(properties, 'target') ??
    propertyString(properties, 'graphNodeId') ??
    capitalizeKind(kind)
  );
}

export function nodeLabelsFromProperties(
  properties: Record<string, unknown>,
  kind: string,
): string[] {
  const graphLabels = properties.graphLabels;
  if (Array.isArray(graphLabels) && graphLabels.every(isNonEmptyString)) {
    return [...graphLabels];
  }
  return [capitalizeKind(kind)];
}

export function bindSafeJsonParameter(
  sql: Pick<import('postgres').Sql, 'json'>,
  value: Record<string, unknown>,
  label: string,
) {
  const safeValue = requireSafeJsonObject(value, label);
  // Safe JSON is validated above; postgres.js json helper binds JSONB without string interpolation.
  return sql.json(safeValue as Parameters<import('postgres').Sql['json']>[0]);
}

export function logRelationalMutationUnavailable(operation: string, error: unknown): void {
  console.error(
    JSON.stringify({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      event: 'graph_mutation_unavailable',
      operation,
      provider: 'postgres_relational',
    }),
  );
}

export function logRelationalReadUnavailable(operation: string, error: unknown): void {
  console.error(
    JSON.stringify({
      errorName: error instanceof Error ? error.name : 'UnknownError',
      event: 'graph_read_unavailable',
      operation,
      provider: 'postgres_relational',
    }),
  );
}

export function createMutationUnavailableError(): Error {
  return new Error(GRAPH_MUTATION_UNAVAILABLE_MESSAGE);
}

export function createReadUnavailableError(): Error {
  return new Error(GRAPH_READ_UNAVAILABLE_MESSAGE);
}

export function graphRelationQueryRowLimit(
  relationLimit: number,
  seedDocumentCount: number,
): number {
  return Math.min(Math.max(1, relationLimit) * Math.max(1, seedDocumentCount), 50);
}

function deriveSubtype(kind: RelationalGraphNodeKind, properties: Record<string, unknown>): string {
  if (kind === 'document') {
    return requireNonEmptyString(properties.docType, 'docType');
  }
  if (kind === 'topic') {
    return requireNonEmptyString(properties.topicType, 'topicType');
  }
  const actorType = propertyString(properties, 'actorType');
  return actorType ?? 'person';
}

function requireSafeJsonObject(value: unknown, label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const nested of Object.values(record)) {
    requireSafeJsonValue(nested, label);
  }
  return record;
}

function capitalizeKind(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseGraphCountFromRows(rows: readonly unknown[], label: string): number {
  if (rows.length !== 1) {
    throw new Error(`Invalid relational ${label}.`);
  }
  return parseGraphCountResult(parseRelationalCountRow(rows[0], label));
}

export function safeJsonPreview(value: unknown): unknown {
  return requireSafeJsonValue(value, 'graph raw row value');
}
