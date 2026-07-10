import type { SourceType } from './ingestion-fixtures.js';

export interface StoredSourceIdentity {
  readonly logicalSourceId: string;
  readonly sourceVersion: string;
}

export function gmailLogicalSourceId(threadId: string): string {
  const normalized = threadId.trim();
  if (!normalized) {
    throw new Error('Gmail thread ID is required for logical source identity.');
  }
  return normalized;
}

export function gmailSourceVersion(messageId: string): string {
  const normalized = messageId.trim();
  if (!normalized) {
    throw new Error('Gmail message ID is required for source version.');
  }
  return normalized;
}

export function driveLogicalSourceId(fileId: string): string {
  const normalized = fileId.trim();
  if (!normalized) {
    throw new Error('Drive file ID is required for logical source identity.');
  }
  return normalized;
}

export function driveSourceVersion(revisionId: string): string {
  const normalized = revisionId.trim();
  if (!normalized) {
    throw new Error('Drive revision ID is required for source version.');
  }
  return normalized;
}

export function githubLogicalSourceId(input: {
  kind: 'issue' | 'pull_request';
  number: number;
  repository: string;
}): string {
  const segment = input.kind === 'pull_request' ? 'pulls' : 'issues';
  const normalized = `${input.repository.toLowerCase()}/${segment}/${input.number}`.trim();
  if (normalized.length < 3) {
    throw new Error('GitHub logical source identity is too short.');
  }
  return normalized;
}

export function githubSourceVersion(updatedAt: string, contentHash: string): string {
  const normalizedUpdatedAt = updatedAt.trim();
  if (!normalizedUpdatedAt) {
    throw new Error('GitHub updated_at is required for source version.');
  }
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('GitHub source version requires a sha256 content hash.');
  }
  return `${normalizedUpdatedAt}:${contentHash}`;
}

export function webLogicalSourceId(configuredUrl: string): string {
  try {
    const url = new URL(configuredUrl.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    const normalized = url.toString();
    if (normalized.length < 3) {
      throw new Error(`Normalized web logical source ID is too short: ${configuredUrl}`);
    }
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message.includes('too short')) {
      throw error;
    }
    throw new Error(`Invalid web configured URL: ${configuredUrl}`);
  }
}

export function webSourceVersion(contentHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error('Web source version requires a sha256 content hash.');
  }
  return contentHash;
}

export function legacyLogicalSourceId(sourceId: string): string {
  const normalized = sourceId.trim();
  if (!normalized) {
    throw new Error('Legacy logical source identity requires a source ID.');
  }
  return `legacy:${normalized}`;
}

export function legacyDocumentLogicalSourceId(documentId: string): string {
  const normalized = documentId.trim();
  if (!normalized) {
    throw new Error('Legacy document logical source identity requires a document ID.');
  }
  return `legacy:doc:${normalized}`;
}

/**
 * Derives stored logical identity for existing rows or fixtures using the same rules as migration backfill.
 */
export function deriveStoredSourceIdentity(input: {
  contentHash: string;
  metadata: Record<string, unknown>;
  sourceId: string;
  sourceType: SourceType;
}): StoredSourceIdentity {
  const metadataThreadId = readNonEmptyString(input.metadata.threadId);
  const metadataMessageId = readNonEmptyString(input.metadata.messageId);
  const metadataFileId = readNonEmptyString(input.metadata.fileId);
  const metadataRevisionId = readNonEmptyString(input.metadata.revisionId);
  const metadataUpdatedAt = readNonEmptyString(input.metadata.updatedAt);
  const [sourcePrefix, sourceSuffix] = splitSourceIdParts(input.sourceId);

  switch (input.sourceType) {
    case 'gmail': {
      const threadId = metadataThreadId ?? sourcePrefix;
      const messageId = metadataMessageId ?? sourceSuffix;
      if (threadId && messageId) {
        return {
          logicalSourceId: gmailLogicalSourceId(threadId),
          sourceVersion: gmailSourceVersion(messageId),
        };
      }
      break;
    }
    case 'drive': {
      const fileId = metadataFileId ?? sourcePrefix;
      const revisionId = metadataRevisionId ?? sourceSuffix;
      if (fileId && revisionId) {
        return {
          logicalSourceId: driveLogicalSourceId(fileId),
          sourceVersion: driveSourceVersion(revisionId),
        };
      }
      break;
    }
    case 'github': {
      if (metadataUpdatedAt) {
        return {
          logicalSourceId: input.sourceId,
          sourceVersion: githubSourceVersion(metadataUpdatedAt, input.contentHash),
        };
      }
      return {
        logicalSourceId: input.sourceId,
        sourceVersion: githubSourceVersion('unknown', input.contentHash),
      };
    }
    case 'web':
      return {
        logicalSourceId: input.sourceId,
        sourceVersion: webSourceVersion(input.contentHash),
      };
  }

  return {
    logicalSourceId: legacyLogicalSourceId(input.sourceId),
    sourceVersion: input.contentHash,
  };
}

function splitSourceIdParts(sourceId: string): [string | undefined, string | undefined] {
  const separatorIndex = sourceId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= sourceId.length - 1) {
    return [undefined, undefined];
  }
  return [sourceId.slice(0, separatorIndex), sourceId.slice(separatorIndex + 1)];
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
