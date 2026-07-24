import type { GitHubLifecycleTarget } from '../../packages/ingestion/dist/index.js';
import { parseGitHubDocumentLifecycle } from '../../packages/ingestion/dist/index.js';
import { parseOptionalCanonicalUuid } from './uuid.ts';

export function parseGitHubLifecycleTargetRow(value: unknown): GitHubLifecycleTarget {
  const row = requireRecord(value, 'github lifecycle target row');
  const metadata = parseMetadataRecord(row.metadata);
  const kind = row.kind === 'pull_request' ? 'pull_request' : 'issue';
  const connectionId = parseOptionalCanonicalUuid(row.connectionId, 'connectionId');
  return {
    connectionId,
    dataSourceId: requireString(row.dataSourceId, 'dataSourceId'),
    kind,
    lifecycle: parseGitHubDocumentLifecycle(metadata.githubLifecycle),
    logicalSourceId: requireString(row.logicalSourceId, 'logicalSourceId'),
    number: requireNumber(row.number, 'number'),
    projectId: requireString(row.projectId, 'projectId'),
    projectSlug: requireString(row.projectSlug, 'projectSlug'),
    rawBody: '',
    rawDocumentId: requireString(row.rawDocumentId, 'rawDocumentId'),
    rawMetadata: metadata,
    repository: requireString(row.repository, 'repository'),
    sourceUri: requireString(row.sourceUri, 'sourceUri'),
    sourceVersion: requireString(row.sourceVersion, 'sourceVersion'),
    storageUri: requireString(row.storageUri, 'storageUri'),
  };
}

export function parseGitHubLifecycleTargetRows(values: unknown): GitHubLifecycleTarget[] {
  if (!Array.isArray(values)) {
    throw new Error('Invalid GitHub lifecycle target rows.');
  }
  return values.map((value) => parseGitHubLifecycleTargetRow(value));
}

function parseMetadataRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Invalid GitHub lifecycle metadata.');
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Invalid ${context}.`);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  return value;
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Invalid field: ${fieldName}`);
}
