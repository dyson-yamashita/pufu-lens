import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type IngestionFixtureCase,
  loadIngestionFixtureCases,
  type SourceType,
} from './ingestion-fixtures.js';

export interface CollectionObjectStorage {
  put(
    uri: string,
    body: Buffer | NodeJS.ReadableStream | string,
    opts?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<{ etag?: string; uri: string }>;
}

export type CollectDecision =
  | 'collected'
  | 'linked_existing'
  | 'queued_failed'
  | 'skipped_existing';

export interface ProjectRecord {
  id: string;
  slug: string;
}

export interface DataSourceRecord {
  config: Record<string, unknown>;
  enabled: boolean;
  id: string;
  ingestWindow: Record<string, unknown>;
  projectId: string;
  sourceType: SourceType;
}

export interface RawDocumentRecord {
  id: string;
  ingestStatus: 'fetched' | 'held' | 'parsed' | 'indexed' | 'failed';
  sourceId: string;
  sourceType: SourceType;
}

export interface RawDocumentInput {
  byteSize: number;
  contentHash: string;
  metadata: Record<string, unknown>;
  mimeType: string;
  projectId: string;
  sourceId: string;
  sourceType: SourceType;
  sourceUri: string;
  storageUri: string;
}

export interface LinkDataSourceInput {
  dataSourceId: string;
  matchReason: string;
  metadata: Record<string, unknown>;
  projectId: string;
  rawDocumentId: string;
}

export interface QueueCandidateInput {
  dataSourceId: string;
  projectId: string;
  rawDocumentId: string;
  targetId: string;
  targetUri: string;
}

export interface CollectionRepository {
  findDataSources(projectId: string, sourceType?: SourceType): Promise<DataSourceRecord[]>;
  findSameHashCandidates(input: {
    contentHash: string;
    projectId: string;
    sourceType: SourceType;
  }): Promise<Array<{ id: string; sourceId: string; sourceType: SourceType }>>;
  linkDataSource(input: LinkDataSourceInput): Promise<void>;
  lookupProjectBySlug(slug: string): Promise<ProjectRecord | undefined>;
  lookupRawDocument(input: {
    projectId: string;
    sourceId: string;
    sourceType: SourceType;
  }): Promise<RawDocumentRecord | undefined>;
  markDataSourceChecked(dataSourceId: string): Promise<void>;
  queueCandidate(input: QueueCandidateInput): Promise<void>;
  upsertRawDocument(input: RawDocumentInput): Promise<RawDocumentRecord>;
}

export interface FixtureCandidate {
  fixture: IngestionFixtureCase;
  rawPath: string;
  raw: RawDocumentInput;
}

export interface CollectFixtureOptions {
  projectSlug: string;
  repoRoot: string;
  repository: CollectionRepository;
  sourceType?: SourceType;
  storage: CollectionObjectStorage;
}

export interface CollectFixtureResult {
  decisions: Array<{
    dataSourceId: string;
    decision: CollectDecision;
    rawDocumentId: string;
    sourceId: string;
    sourceType: SourceType;
  }>;
  projectSlug: string;
}

export async function collectFixtureSource(
  options: CollectFixtureOptions,
): Promise<CollectFixtureResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const dataSources = await options.repository.findDataSources(project.id, options.sourceType);
  const decisions: CollectFixtureResult['decisions'] = [];

  for (const dataSource of dataSources.filter((source) => source.enabled)) {
    const candidates = await scanFixtureSource({
      projectId: project.id,
      projectSlug: project.slug,
      sourceType: dataSource.sourceType,
    });

    for (const candidate of candidates) {
      if (!shouldCollectCandidate({ candidate, dataSource })) {
        continue;
      }

      const sourceId = normalizeSourceId(candidate.raw.sourceType, candidate.raw.sourceId);
      const existing = await options.repository.lookupRawDocument({
        projectId: project.id,
        sourceId,
        sourceType: candidate.raw.sourceType,
      });

      if (existing) {
        await options.repository.linkDataSource({
          dataSourceId: dataSource.id,
          matchReason: 'fixture-source-match',
          metadata: { fixtureId: candidate.fixture.id },
          projectId: project.id,
          rawDocumentId: existing.id,
        });

        if (existing.ingestStatus === 'failed') {
          await options.repository.queueCandidate({
            dataSourceId: dataSource.id,
            projectId: project.id,
            rawDocumentId: existing.id,
            targetId: sourceId,
            targetUri: candidate.raw.sourceUri,
          });
          decisions.push({
            dataSourceId: dataSource.id,
            decision: 'queued_failed',
            rawDocumentId: existing.id,
            sourceId,
            sourceType: candidate.raw.sourceType,
          });
        } else {
          decisions.push({
            dataSourceId: dataSource.id,
            decision: 'skipped_existing',
            rawDocumentId: existing.id,
            sourceId,
            sourceType: candidate.raw.sourceType,
          });
        }
        continue;
      }

      const rawContent = await readFile(join(options.repoRoot, candidate.rawPath));
      const sameHashCandidates = await options.repository.findSameHashCandidates({
        contentHash: candidate.raw.contentHash,
        projectId: project.id,
        sourceType: candidate.raw.sourceType,
      });
      const metadata = {
        ...candidate.raw.metadata,
        fixtureId: candidate.fixture.id,
        sameAsCandidateRawDocumentIds: sameHashCandidates.map((raw) => raw.id),
      };
      const stored = await options.storage.put(candidate.raw.storageUri, rawContent, {
        contentType: candidate.raw.mimeType,
      });
      const rawDocument = await options.repository.upsertRawDocument({
        ...candidate.raw,
        byteSize: rawContent.byteLength,
        metadata,
        sourceId,
        storageUri: stored.uri,
      });

      await options.repository.linkDataSource({
        dataSourceId: dataSource.id,
        matchReason: 'fixture-source-match',
        metadata: { fixtureId: candidate.fixture.id },
        projectId: project.id,
        rawDocumentId: rawDocument.id,
      });
      await options.repository.queueCandidate({
        dataSourceId: dataSource.id,
        projectId: project.id,
        rawDocumentId: rawDocument.id,
        targetId: sourceId,
        targetUri: candidate.raw.sourceUri,
      });

      decisions.push({
        dataSourceId: dataSource.id,
        decision: 'collected',
        rawDocumentId: rawDocument.id,
        sourceId,
        sourceType: candidate.raw.sourceType,
      });
    }

    await options.repository.markDataSourceChecked(dataSource.id);
  }

  return { decisions, projectSlug: project.slug };
}

export async function scanFixtureSource(input: {
  projectId: string;
  projectSlug: string;
  sourceType?: SourceType;
}): Promise<FixtureCandidate[]> {
  const fixtureCases = await loadIngestionFixtureCases();

  return fixtureCases
    .filter((fixtureCase) => !input.sourceType || fixtureCase.sourceType === input.sourceType)
    .map((fixtureCase) => ({
      fixture: fixtureCase,
      raw: {
        byteSize: 0,
        contentHash: fixtureCase.raw.contentHash,
        metadata: fixtureCase.raw.metadata,
        mimeType: fixtureCase.raw.mimeType,
        projectId: input.projectId,
        sourceId: normalizeSourceId(fixtureCase.sourceType, fixtureCase.raw.sourceId),
        sourceType: fixtureCase.sourceType,
        sourceUri: fixtureCase.raw.sourceUri,
        storageUri: `${input.projectSlug}/raw/${fixtureCase.sourceType}/${basename(
          fixtureCase.raw.storageUri,
        )}`,
      },
      rawPath: fixtureCase.rawPath,
    }));
}

export function shouldCollectCandidate(input: {
  candidate: FixtureCandidate;
  dataSource: DataSourceRecord;
}): boolean {
  const { candidate, dataSource } = input;
  if (!dataSource.enabled || dataSource.sourceType !== candidate.raw.sourceType) {
    return false;
  }

  const fixtureIds = readStringArray(dataSource.config.fixtureIds);
  if (fixtureIds && !fixtureIds.includes(candidate.fixture.id)) {
    return false;
  }

  const sourceIds = readStringArray(dataSource.config.sourceIds);
  if (sourceIds && !sourceIds.includes(candidate.raw.sourceId)) {
    return false;
  }

  const since = readString(dataSource.ingestWindow.since);
  if (since) {
    const sinceTime = Date.parse(since);
    const candidateDate = readString(candidate.raw.metadata.fetchedAt);
    if (candidateDate && !Number.isNaN(sinceTime)) {
      const candidateTime = Date.parse(candidateDate);
      if (!Number.isNaN(candidateTime) && candidateTime < sinceTime) {
        return false;
      }
    }
  }

  return true;
}

export function normalizeSourceId(sourceType: SourceType, sourceId: string): string {
  const normalized = sourceType === 'web' ? normalizeWebSourceId(sourceId) : sourceId.trim();
  if (normalized.length < 3) {
    throw new Error(`Normalized source_id is too short for ${sourceType}: ${sourceId}`);
  }

  return normalized;
}

function normalizeWebSourceId(sourceId: string): string {
  try {
    const url = new URL(sourceId);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    throw new Error(`Invalid web source_id URL: ${sourceId}`);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === 'string');
}
