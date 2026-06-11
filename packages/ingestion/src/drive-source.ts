import { createHash } from 'node:crypto';
import type {
  CollectDecision,
  CollectionObjectStorage,
  CollectionRepository,
  DataSourceRecord,
  RawDocumentInput,
} from './collection-pipeline.js';
import { normalizeSourceId } from './collection-pipeline.js';

export interface DriveOwnerResponse {
  displayName?: string;
  emailAddress?: string;
}

export interface DriveFileResponse {
  headRevisionId?: string;
  id: string;
  md5Checksum?: string;
  mimeType: string;
  modifiedTime: string;
  name: string;
  owners?: DriveOwnerResponse[];
  version?: string;
  webViewLink?: string;
}

export interface DriveListResponse {
  files: DriveFileResponse[];
  nextPageToken?: string;
}

export interface DriveRawDocument {
  bodyText: string;
  fileId: string;
  mimeType: string;
  modifiedTime: string;
  owners: Array<{ email: string; name: string }>;
  revisionId: string;
  title: string;
  webViewLink: string;
}

export type DriveFetcher = (input: { path: string; token?: string }) => Promise<unknown>;

export type DriveTextFetcher = (input: {
  file: DriveFileResponse;
  token?: string;
}) => Promise<string>;

export interface DriveCandidate {
  file: DriveFileResponse;
  folderId: string;
}

export interface DriveRawCandidate {
  body: string;
  raw: RawDocumentInput;
}

export interface CollectDriveSourceOptions {
  dryRun?: boolean;
  fetcher?: DriveFetcher;
  limit?: number;
  projectSlug: string;
  repository: CollectionRepository;
  storage: CollectionObjectStorage;
  textFetcher?: DriveTextFetcher;
  token?: string;
}

export interface CollectDriveSourceResult {
  decisions: Array<{
    dataSourceId: string;
    decision: CollectDecision | 'would_collect' | 'would_skip_existing';
    error?: string;
    rawDocumentId?: string;
    sourceId: string;
    sourceType: 'drive';
  }>;
  dryRun: boolean;
  failureCount: number;
  projectSlug: string;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_USER_AGENT = 'pufu-lens-drive-collector/0.1';
const GOOGLE_DOC_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
]);
const TEXT_FILE_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);

export async function collectDriveSource(
  options: CollectDriveSourceOptions,
): Promise<CollectDriveSourceResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const fetcher = options.fetcher ?? fetchDriveJson;
  const textFetcher = options.textFetcher ?? fetchDriveText;
  const dataSources = await options.repository.findDataSources(project.id, 'drive');
  const decisions: CollectDriveSourceResult['decisions'] = [];
  let remainingLimit = options.limit;

  for (const dataSource of dataSources.filter((source) => source.enabled)) {
    if (remainingLimit !== undefined && remainingLimit <= 0) {
      break;
    }

    const candidates = await scanDriveDataSource({
      dataSource,
      fetcher,
      limit: remainingLimit,
      token: options.token,
    });

    for (const candidate of candidates) {
      if (remainingLimit !== undefined && remainingLimit <= 0) {
        break;
      }
      if (remainingLimit !== undefined) {
        remainingLimit -= 1;
      }

      const sourceId = driveCandidateSourceId(candidate);
      const existing = await options.repository.lookupRawDocument({
        projectId: project.id,
        sourceId,
        sourceType: 'drive',
      });

      if (existing) {
        if (!options.dryRun) {
          await options.repository.linkDataSource({
            dataSourceId: dataSource.id,
            matchReason: 'drive-folder-source-match',
            metadata: { folderId: candidate.folderId },
            projectId: project.id,
            rawDocumentId: existing.id,
          });

          if (existing.ingestStatus === 'failed') {
            await options.repository.queueCandidate({
              dataSourceId: dataSource.id,
              projectId: project.id,
              rawDocumentId: existing.id,
              targetId: sourceId,
              targetUri: driveWebViewLink(candidate.file),
            });
          }
        }

        decisions.push({
          dataSourceId: dataSource.id,
          decision: options.dryRun
            ? 'would_skip_existing'
            : existing.ingestStatus === 'failed'
              ? 'queued_failed'
              : 'skipped_existing',
          rawDocumentId: existing.id,
          sourceId,
          sourceType: 'drive',
        });
        continue;
      }

      if (options.dryRun) {
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'would_collect',
          sourceId,
          sourceType: 'drive',
        });
        continue;
      }

      let rawCandidate: DriveRawCandidate;
      try {
        rawCandidate = await buildDriveRawCandidate({
          candidate,
          dataSource,
          projectId: project.id,
          projectSlug: project.slug,
          textFetcher,
          token: options.token,
        });
      } catch (error) {
        const sanitizedError = sanitizeError(error);
        console.error(
          `Failed to build raw Drive candidate for ${redactDriveUri(
            driveWebViewLink(candidate.file),
          )}: ${sanitizedError}`,
        );
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'failed',
          error: sanitizedError,
          sourceId,
          sourceType: 'drive',
        });
        continue;
      }

      const sameHashCandidates = await options.repository.findSameHashCandidates({
        contentHash: rawCandidate.raw.contentHash,
        projectId: project.id,
        sourceType: 'drive',
      });
      const stored = await options.storage.put(rawCandidate.raw.storageUri, rawCandidate.body, {
        contentType: rawCandidate.raw.mimeType,
      });
      const rawDocument = await options.repository.upsertRawDocument({
        ...rawCandidate.raw,
        metadata: {
          ...rawCandidate.raw.metadata,
          sameAsCandidateRawDocumentIds: sameHashCandidates.map((raw) => raw.id),
        },
        storageUri: stored.uri,
      });

      await options.repository.linkDataSource({
        dataSourceId: dataSource.id,
        matchReason: 'drive-folder-source-match',
        metadata: { folderId: candidate.folderId },
        projectId: project.id,
        rawDocumentId: rawDocument.id,
      });
      await options.repository.queueCandidate({
        dataSourceId: dataSource.id,
        projectId: project.id,
        rawDocumentId: rawDocument.id,
        targetId: sourceId,
        targetUri: rawCandidate.raw.sourceUri,
      });

      decisions.push({
        dataSourceId: dataSource.id,
        decision: 'collected',
        rawDocumentId: rawDocument.id,
        sourceId,
        sourceType: 'drive',
      });
    }

    if (!options.dryRun) {
      await options.repository.markDataSourceChecked(dataSource.id);
    }
  }

  return {
    decisions,
    dryRun: options.dryRun ?? false,
    failureCount: countFailedDecisions(decisions),
    projectSlug: project.slug,
  };
}

function countFailedDecisions(decisions: CollectDriveSourceResult['decisions']): number {
  return decisions.filter((decision) => decision.decision === 'failed').length;
}

export async function scanDriveDataSource(input: {
  dataSource: DataSourceRecord;
  fetcher: DriveFetcher;
  limit?: number;
  token?: string;
}): Promise<DriveCandidate[]> {
  const { dataSource, fetcher, limit, token } = input;
  if (dataSource.sourceType !== 'drive' || !dataSource.enabled) {
    return [];
  }

  const folderIds = readFolderIds(dataSource.config);
  const candidates: DriveCandidate[] = [];
  for (const folderId of folderIds) {
    let pageToken: string | undefined;
    do {
      if (limit !== undefined && candidates.length >= limit) {
        break;
      }

      const searchParams = new URLSearchParams({
        fields:
          'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress),headRevisionId,version,md5Checksum)',
        orderBy: 'modifiedTime desc',
        pageSize: String(drivePageSize(limit)),
        q: driveQuery(folderId, dataSource.ingestWindow.since),
        supportsAllDrives: 'true',
      });
      if (pageToken) {
        searchParams.set('pageToken', pageToken);
      }

      const response = validateDriveListResponse(
        await fetcher({ path: `/drive/v3/files?${searchParams.toString()}`, token }),
      );
      for (const file of response.files) {
        if (limit !== undefined && candidates.length >= limit) {
          break;
        }
        if (!shouldIncludeFile(file, dataSource.config)) {
          continue;
        }
        candidates.push({ file, folderId });
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
  }

  return candidates;
}

export async function buildDriveRawCandidate(input: {
  candidate: DriveCandidate;
  dataSource: DataSourceRecord;
  projectId: string;
  projectSlug: string;
  textFetcher: DriveTextFetcher;
  token?: string;
}): Promise<DriveRawCandidate> {
  const { candidate } = input;
  const bodyText = await input.textFetcher({ file: candidate.file, token: input.token });
  const sourceId = driveCandidateSourceId(candidate);
  const rawDocument: DriveRawDocument = {
    bodyText,
    fileId: candidate.file.id,
    mimeType: candidate.file.mimeType,
    modifiedTime: candidate.file.modifiedTime,
    owners: driveOwners(candidate.file.owners),
    revisionId: driveRevisionId(candidate.file),
    title: candidate.file.name,
    webViewLink: driveWebViewLink(candidate.file),
  };
  const body = `${JSON.stringify(rawDocument, null, 2)}\n`;
  const contentHash = sha256Hex(body);
  const fetchedAt = new Date().toISOString();

  return {
    body,
    raw: {
      byteSize: Buffer.byteLength(body),
      contentHash,
      metadata: {
        dataSourceId: input.dataSource.id,
        fetchedAt,
        fileId: rawDocument.fileId,
        folderId: candidate.folderId,
        mimeType: rawDocument.mimeType,
        modifiedTime: rawDocument.modifiedTime,
        ownerCount: rawDocument.owners.length,
        revisionId: rawDocument.revisionId,
        title: rawDocument.title,
      },
      mimeType: 'application/json',
      projectId: input.projectId,
      sourceId,
      sourceType: 'drive',
      sourceUri: rawDocument.webViewLink,
      storageUri: `${input.projectSlug}/raw/drive/${safeStorageSegment(sourceId)}.json`,
    },
  };
}

export async function fetchDriveJson(input: { path: string; token?: string }): Promise<unknown> {
  const url = new URL(input.path, 'https://www.googleapis.com');
  const response = await fetch(url.toString(), {
    headers: driveHeaders(input.token),
  });
  if (!response.ok) {
    throw new Error(`Drive API request failed with status ${response.status}: ${input.path}`);
  }
  return response.json();
}

export async function fetchDriveText(input: {
  file: DriveFileResponse;
  token?: string;
}): Promise<string> {
  if (!isDriveTextReadableMimeType(input.file.mimeType)) {
    throw new Error(`Unsupported Drive MIME type for text extraction: ${input.file.mimeType}`);
  }

  const path = driveTextFetchPath(input.file);
  const url = new URL(path, 'https://www.googleapis.com');
  const response = await fetch(url.toString(), {
    headers: driveHeaders(input.token),
  });
  if (!response.ok) {
    throw new Error(
      `Drive file text request failed with status ${response.status}: ${input.file.id}`,
    );
  }
  return response.text();
}

function driveCandidateSourceId(candidate: DriveCandidate): string {
  return normalizeSourceId('drive', `${candidate.file.id}:${driveRevisionId(candidate.file)}`);
}

function driveHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'user-agent': DEFAULT_USER_AGENT,
  };
}

function drivePageSize(limit: number | undefined): number {
  const requested = Number.isFinite(limit) ? Number(limit) : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(requested, DEFAULT_PAGE_SIZE));
}

function isDriveTextReadableMimeType(mimeType: string): boolean {
  return (
    GOOGLE_DOC_MIME_TYPES.has(mimeType) ||
    TEXT_FILE_MIME_TYPES.has(mimeType) ||
    mimeType.startsWith('text/')
  );
}

function driveTextFetchPath(file: DriveFileResponse): string {
  const encodedFileId = encodeURIComponent(file.id);
  if (file.mimeType === 'application/vnd.google-apps.document') {
    return `/drive/v3/files/${encodedFileId}/export?mimeType=text/plain`;
  }
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    return `/drive/v3/files/${encodedFileId}/export?mimeType=text/csv`;
  }
  return `/drive/v3/files/${encodedFileId}?alt=media`;
}

function driveOwners(
  owners: DriveOwnerResponse[] | undefined,
): Array<{ email: string; name: string }> {
  return (owners ?? []).map((owner) => ({
    email: owner.emailAddress ?? '',
    name: owner.displayName?.trim() || owner.emailAddress || 'Unknown Drive Owner',
  }));
}

function driveQuery(folderId: string, since: unknown): string {
  const parts = [`'${escapeDriveQueryValue(folderId)}' in parents`, 'trashed = false'];
  if (typeof since === 'string' && !Number.isNaN(Date.parse(since))) {
    parts.push(`modifiedTime > '${escapeDriveQueryValue(new Date(since).toISOString())}'`);
  }
  return parts.join(' and ');
}

function driveRevisionId(file: DriveFileResponse): string {
  return file.headRevisionId ?? file.version ?? file.modifiedTime;
}

function driveWebViewLink(file: DriveFileResponse): string {
  return file.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
}

function readFolderIds(config: Record<string, unknown>): string[] {
  const folderIds = [
    ...readStringArray(config.folderIds),
    ...readSingleString(config.folderId),
    ...readStringArray(config.folders),
    ...readStringArray(config.folderUrls).map(readFolderIdFromUrl),
    ...readSingleString(config.folderUrl).map(readFolderIdFromUrl),
  ]
    .map((folderId) => folderId.trim())
    .filter((folderId) => /^[A-Za-z0-9_-]+$/.test(folderId));
  return [...new Set(folderIds)];
}

function readFolderIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const folderMatch = url.pathname.match(/\/folders\/(?<folderId>[A-Za-z0-9_-]+)/);
    if (folderMatch?.groups?.folderId) {
      return folderMatch.groups.folderId;
    }
    return url.searchParams.get('id') ?? value;
  } catch {
    return value;
  }
}

function shouldIncludeFile(file: DriveFileResponse, config: Record<string, unknown>): boolean {
  const allowedMimeTypes = readStringArray(config.mimeTypes);
  if (allowedMimeTypes.length > 0 && !allowedMimeTypes.includes(file.mimeType)) {
    return false;
  }
  const fileIds = readStringArray(config.fileIds);
  return fileIds.length === 0 || fileIds.includes(file.id);
}

function validateDriveListResponse(value: unknown): DriveListResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Drive files response must be an object.');
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.files)) {
    throw new Error('Drive files response files must be an array.');
  }
  return {
    files: response.files.map(validateDriveFile),
    nextPageToken: readString(response.nextPageToken),
  };
}

function validateDriveFile(value: unknown): DriveFileResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Drive file response item must be an object.');
  }
  const file = value as Record<string, unknown>;
  return {
    headRevisionId: readString(file.headRevisionId),
    id: requiredString(file.id, 'file.id'),
    md5Checksum: readString(file.md5Checksum),
    mimeType: requiredString(file.mimeType, 'file.mimeType'),
    modifiedTime: requiredString(file.modifiedTime, 'file.modifiedTime'),
    name: requiredString(file.name, 'file.name'),
    owners: validateOwners(file.owners),
    version: readString(file.version),
    webViewLink: readString(file.webViewLink),
  };
}

function validateOwners(value: unknown): DriveOwnerResponse[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Drive file owners must be an array.');
  }
  return value.map((owner) => {
    if (typeof owner !== 'object' || owner === null) {
      throw new Error('Drive file owner must be an object.');
    }
    const item = owner as Record<string, unknown>;
    return {
      displayName: readString(item.displayName),
      emailAddress: readString(item.emailAddress),
    };
  });
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function readSingleString(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Drive response field ${field} must be a string.`);
  }
  return value;
}

function safeStorageSegment(value: string): string {
  const hash = sha256Hex(value).slice(0, 12);
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 107);
  return clean ? `${clean}-${hash}` : hash;
}

function redactDriveUri(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    return url.toString();
  } catch {
    return '<invalid-drive-url>';
  }
}

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : String(error);
  return message
    .replace(/(token|secret|api[_-]?key)=\S+/gi, '$1=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .slice(0, 500);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
