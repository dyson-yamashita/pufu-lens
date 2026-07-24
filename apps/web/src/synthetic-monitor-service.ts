import {
  driveLogicalSourceId,
  driveSourceVersion,
  githubLogicalSourceId,
  gmailLogicalSourceId,
  gmailSourceVersion,
  webLogicalSourceId,
  webSourceVersion,
} from '@pufu-lens/ingestion/source-version-identity';
import { validateGraphName } from '@pufu-lens/project-tenancy';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  isSyntheticMonitorArtifactConsistent,
  readBoundedUtf8FromStream,
} from './synthetic-monitor-artifact.ts';
import {
  parseSyntheticMonitorProjectSlugs,
  SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES,
  SYNTHETIC_MONITOR_CONTRACT_VERSION,
  SYNTHETIC_MONITOR_RELATION_TYPES,
  SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS,
  SYNTHETIC_MONITOR_STATEMENT_TIMEOUT_MS,
  type SyntheticMonitorChunkStageObservation,
  type SyntheticMonitorExpectedRelation,
  type SyntheticMonitorGraphStageObservation,
  type SyntheticMonitorRelationType,
  type SyntheticMonitorReportArtifactObservation,
  type SyntheticMonitorReportFrequency,
  type SyntheticMonitorReportInput,
  type SyntheticMonitorReportObservation,
  type SyntheticMonitorRequest,
  type SyntheticMonitorResponse,
  type SyntheticMonitorScheduleStageObservation,
  type SyntheticMonitorSourceInput,
  type SyntheticMonitorSourceKind,
  type SyntheticMonitorSourceObservation,
  type SyntheticMonitorStageStatus,
} from './synthetic-monitor-contract.ts';
import { aggregateScheduleStageObservation } from './synthetic-monitor-schedule.ts';

export interface SyntheticMonitorProjectRecord {
  readonly graphName: string;
  readonly id: string;
  readonly slug: string;
}

export interface SyntheticMonitorRawDocumentRecord {
  readonly id: string;
  readonly ingestStatus: string;
  readonly sourceVersion: string;
}

export interface SyntheticMonitorDocumentRecord {
  readonly graphNodeId: string | null;
  readonly id: string;
  readonly rawDocumentId: string;
}

export interface SyntheticMonitorScheduleRecord {
  readonly enabled: boolean;
  readonly leaseExpiresAt: string | null;
  readonly nextRunAt: string | null;
  readonly retryCount: number;
}

export interface SyntheticMonitorReportScheduleRecord {
  readonly frequency: string;
  readonly nextRunAt: string | null;
}

export interface SyntheticMonitorPeriodRunRecord {
  readonly reportId: string | null;
  readonly status: string;
}

export interface SyntheticMonitorReportMetadataRecord {
  readonly schemaVersion: string;
  readonly storageUri: string;
}

export interface SyntheticMonitorRepository {
  countDocumentChunks(input: {
    readonly documentId: string;
    readonly projectId: string;
  }): Promise<{ readonly total: number; readonly withEmbedding: number }>;
  countGraphDocumentNode(input: {
    readonly graphName: string;
    readonly graphNodeId: string;
  }): Promise<number>;
  countGraphRelations(input: {
    readonly graphName: string;
    readonly graphNodeId: string;
  }): Promise<Readonly<Record<string, number>>>;
  lookupDocument(input: {
    readonly docType: string;
    readonly logicalSourceId: string;
    readonly projectId: string;
  }): Promise<SyntheticMonitorDocumentRecord | null>;
  lookupLatestRawDocument(input: {
    readonly logicalSourceId: string;
    readonly projectId: string;
    readonly sourceType: string;
  }): Promise<SyntheticMonitorRawDocumentRecord | null>;
  lookupPeriodRun(input: {
    readonly frequency: SyntheticMonitorReportFrequency;
    readonly periodEnd: string;
    readonly periodStart: string;
    readonly projectId: string;
  }): Promise<SyntheticMonitorPeriodRunRecord | null>;
  lookupProject(slug: string): Promise<SyntheticMonitorProjectRecord | null>;
  lookupRawDocument(input: {
    readonly logicalSourceId: string;
    readonly projectId: string;
    readonly sourceType: string;
    readonly sourceVersion: string;
  }): Promise<SyntheticMonitorRawDocumentRecord | null>;
  lookupReportMetadata(input: {
    readonly projectId: string;
    readonly reportId: string;
  }): Promise<SyntheticMonitorReportMetadataRecord | null>;
  lookupReportSchedule(projectId: string): Promise<SyntheticMonitorReportScheduleRecord | null>;
  lookupSchedulesForLogicalSource(input: {
    readonly logicalSourceId: string;
    readonly projectId: string;
    readonly sourceType: string;
  }): Promise<readonly SyntheticMonitorScheduleRecord[]>;
}

/**
 * Runs bounded Synthetic Monitor observations for dedicated project scope.
 *
 * @param input - Parsed request, repository, storage, and allowed project slugs.
 * @returns Machine-readable observation stages without sensitive identifiers.
 */
export async function runSyntheticMonitorObservations(input: {
  readonly allowedProjectSlugs: readonly string[];
  readonly repository: SyntheticMonitorRepository;
  readonly request: SyntheticMonitorRequest;
  readonly storage: ObjectStorage;
}): Promise<SyntheticMonitorResponse> {
  if (!input.allowedProjectSlugs.includes(input.request.projectSlug)) {
    throw new Error('monitor project scope denied');
  }
  const project = await input.repository.lookupProject(input.request.projectSlug);
  if (!project) {
    throw new Error('monitor project scope denied');
  }
  const observations = await Promise.all(
    input.request.sources.map(async (source, index) => {
      try {
        return await observeSource({
          index,
          project,
          repository: input.repository,
          source,
        });
      } catch {
        return failedSourceObservation(index, source.kind);
      }
    }),
  );
  let report: SyntheticMonitorReportObservation | undefined;
  if (input.request.report) {
    try {
      report = await observeReport({
        projectId: project.id,
        report: input.request.report,
        repository: input.repository,
        storage: input.storage,
      });
    } catch {
      report = failedReportObservation();
    }
  }
  return {
    contractVersion: SYNTHETIC_MONITOR_CONTRACT_VERSION,
    projectSlug: project.slug,
    observations,
    ...(report ? { report } : {}),
  };
}

/**
 * Loads dedicated Synthetic Monitor project allowlist from environment variables.
 *
 * @param env - Process environment.
 * @returns Allowed project slugs.
 */
export function loadSyntheticMonitorProjectSlugs(env: NodeJS.ProcessEnv): readonly string[] {
  return parseSyntheticMonitorProjectSlugs(requiredEnv(env, 'SYNTHETIC_MONITOR_PROJECT_SLUGS'));
}

async function observeSource(input: {
  readonly index: number;
  readonly project: SyntheticMonitorProjectRecord;
  readonly repository: SyntheticMonitorRepository;
  readonly source: SyntheticMonitorSourceInput;
}): Promise<SyntheticMonitorSourceObservation> {
  const identity = resolveSourceIdentity(input.source);
  const raw = await observeRawStage(input.repository, input.project.id, identity);
  const currentDocument = await observeCurrentDocumentStage(
    input.repository,
    input.project.id,
    identity,
    raw.status === 'ok' ? identity.sourceVersion : null,
  );
  const chunks = await observeChunkStage(
    input.repository,
    input.project.id,
    identity.docType,
    identity.logicalSourceId,
    currentDocument.status,
  );
  const graph = await observeGraphStage({
    documentStatus: currentDocument.status,
    expectedRelations: identity.expectedRelations,
    graphName: input.project.graphName,
    logicalSourceId: identity.logicalSourceId,
    projectId: input.project.id,
    repository: input.repository,
    docType: identity.docType,
  });
  const schedule =
    identity.sourceType === 'web'
      ? undefined
      : await observeScheduleStage(input.repository, input.project.id, {
          logicalSourceId: identity.logicalSourceId,
          sourceType: identity.sourceType,
        });
  return {
    index: input.index,
    kind: input.source.kind,
    raw,
    currentDocument,
    chunks,
    graph,
    ...(schedule ? { schedule } : {}),
  };
}

async function observeRawStage(
  repository: SyntheticMonitorRepository,
  projectId: string,
  identity: ResolvedSourceIdentity,
): Promise<{ readonly status: SyntheticMonitorStageStatus }> {
  const raw = await repository.lookupRawDocument({
    projectId,
    sourceType: identity.sourceType,
    logicalSourceId: identity.logicalSourceId,
    sourceVersion: identity.sourceVersion,
  });
  if (!raw) return { status: 'not_found' };
  identity.rawDocumentId = raw.id;
  if (raw.ingestStatus === 'indexed') return { status: 'ok' };
  if (raw.ingestStatus === 'failed') return { status: 'failed' };
  return { status: 'pending' };
}

async function observeCurrentDocumentStage(
  repository: SyntheticMonitorRepository,
  projectId: string,
  identity: ResolvedSourceIdentity,
  matchedSourceVersion: string | null,
): Promise<{ readonly status: SyntheticMonitorStageStatus }> {
  if (!matchedSourceVersion || !identity.rawDocumentId) return { status: 'not_found' };
  const latest = await repository.lookupLatestRawDocument({
    projectId,
    sourceType: identity.sourceType,
    logicalSourceId: identity.logicalSourceId,
  });
  if (!latest || latest.sourceVersion !== matchedSourceVersion) return { status: 'pending' };
  const document = await repository.lookupDocument({
    projectId,
    docType: identity.docType,
    logicalSourceId: identity.logicalSourceId,
  });
  if (!document) return { status: 'not_found' };
  if (document.rawDocumentId !== identity.rawDocumentId) return { status: 'pending' };
  identity.graphNodeId = document.graphNodeId;
  return { status: 'ok' };
}

async function observeChunkStage(
  repository: SyntheticMonitorRepository,
  projectId: string,
  docType: string,
  logicalSourceId: string,
  documentStatus: SyntheticMonitorStageStatus,
): Promise<SyntheticMonitorChunkStageObservation> {
  if (documentStatus !== 'ok') {
    return { status: 'not_found', embeddingComplete: false };
  }
  const document = await repository.lookupDocument({ projectId, docType, logicalSourceId });
  if (!document) return { status: 'not_found', embeddingComplete: false };
  const counts = await repository.countDocumentChunks({ projectId, documentId: document.id });
  if (counts.total === 0) return { status: 'pending', embeddingComplete: false };
  const embeddingComplete = counts.withEmbedding === counts.total;
  return {
    status: embeddingComplete ? 'ok' : 'pending',
    embeddingComplete,
  };
}

async function observeGraphStage(input: {
  readonly docType: string;
  readonly documentStatus: SyntheticMonitorStageStatus;
  readonly expectedRelations: readonly SyntheticMonitorExpectedRelation[];
  readonly graphName: string;
  readonly logicalSourceId: string;
  readonly projectId: string;
  readonly repository: SyntheticMonitorRepository;
}): Promise<SyntheticMonitorGraphStageObservation> {
  const emptyRelations = emptyRelationCounts();
  if (input.documentStatus !== 'ok') {
    return { status: 'not_found', documentNodePresent: false, relations: emptyRelations };
  }
  const document = await input.repository.lookupDocument({
    projectId: input.projectId,
    docType: input.docType,
    logicalSourceId: input.logicalSourceId,
  });
  if (!document?.graphNodeId) {
    return { status: 'not_found', documentNodePresent: false, relations: emptyRelations };
  }
  const graphName = validateGraphName(input.graphName);
  const nodeCount = await input.repository.countGraphDocumentNode({
    graphName,
    graphNodeId: document.graphNodeId,
  });
  if (nodeCount !== 1) {
    return { status: 'not_found', documentNodePresent: false, relations: emptyRelations };
  }
  const relationCounts = await input.repository.countGraphRelations({
    graphName,
    graphNodeId: document.graphNodeId,
  });
  const relations = normalizeRelationCounts(relationCounts);
  const relationStatus = evaluateExpectedRelations(input.expectedRelations, relations);
  return {
    status: relationStatus,
    documentNodePresent: true,
    relations,
  };
}

async function observeScheduleStage(
  repository: SyntheticMonitorRepository,
  projectId: string,
  identity: { readonly logicalSourceId: string; readonly sourceType: string },
): Promise<SyntheticMonitorScheduleStageObservation> {
  const schedules = await repository.lookupSchedulesForLogicalSource({
    projectId,
    sourceType: identity.sourceType,
    logicalSourceId: identity.logicalSourceId,
  });
  return aggregateScheduleStageObservation(schedules);
}

async function observeReport(input: {
  readonly projectId: string;
  readonly report: SyntheticMonitorReportInput;
  readonly repository: SyntheticMonitorRepository;
  readonly storage: ObjectStorage;
}): Promise<SyntheticMonitorReportObservation> {
  const scheduleRecord = await input.repository.lookupReportSchedule(input.projectId);
  const schedule = observeReportSchedule(scheduleRecord, input.report.frequency);
  const periodRun = await input.repository.lookupPeriodRun({
    projectId: input.projectId,
    frequency: input.report.frequency,
    periodStart: input.report.periodStart,
    periodEnd: input.report.periodEnd,
  });
  const periodRunObservation = observePeriodRun(periodRun);
  const artifact = await observeReportArtifact({
    periodRun,
    projectId: input.projectId,
    repository: input.repository,
    storage: input.storage,
  });
  return { schedule, periodRun: periodRunObservation, artifact };
}

function observeReportSchedule(
  schedule: SyntheticMonitorReportScheduleRecord | null,
  frequency: SyntheticMonitorReportFrequency,
): SyntheticMonitorReportObservation['schedule'] {
  if (!schedule || schedule.frequency === 'none' || schedule.frequency !== frequency) {
    return { status: 'not_found', frequency: schedule?.frequency ?? null, nextRunDue: false };
  }
  const nextRunDue = schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) <= Date.now();
  return {
    status: nextRunDue ? 'pending' : 'ok',
    frequency: schedule.frequency,
    nextRunDue,
  };
}

function observePeriodRun(
  periodRun: SyntheticMonitorPeriodRunRecord | null,
): SyntheticMonitorReportObservation['periodRun'] {
  if (!periodRun) return { status: 'not_found', runStatus: null };
  if (periodRun.status === 'succeeded') return { status: 'ok', runStatus: periodRun.status };
  if (periodRun.status === 'skipped' || periodRun.status === 'retry_exhausted') {
    return { status: 'failed', runStatus: periodRun.status };
  }
  return { status: 'pending', runStatus: periodRun.status };
}

async function observeReportArtifact(input: {
  readonly periodRun: SyntheticMonitorPeriodRunRecord | null;
  readonly projectId: string;
  readonly repository: SyntheticMonitorRepository;
  readonly storage: ObjectStorage;
}): Promise<SyntheticMonitorReportArtifactObservation> {
  if (!input.periodRun?.reportId) {
    return { status: 'not_found', schemaVersion: null };
  }
  const metadata = await input.repository.lookupReportMetadata({
    projectId: input.projectId,
    reportId: input.periodRun.reportId,
  });
  if (!metadata) return { status: 'not_found', schemaVersion: null };
  const exists = await input.storage.exists(metadata.storageUri);
  if (!exists) return { status: 'not_found', schemaVersion: metadata.schemaVersion };
  const stream = await input.storage.get(metadata.storageUri);
  const bounded = await readBoundedUtf8FromStream(stream, SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES);
  if (bounded.exceeded) {
    return { status: 'failed', schemaVersion: metadata.schemaVersion };
  }
  try {
    const parsed = JSON.parse(bounded.text) as unknown;
    if (
      !isSyntheticMonitorArtifactConsistent({
        artifact: parsed,
        expectedProjectId: input.projectId,
        expectedReportId: input.periodRun.reportId,
        expectedSchemaVersion: metadata.schemaVersion,
      })
    ) {
      return { status: 'failed', schemaVersion: metadata.schemaVersion };
    }
    return { status: 'ok', schemaVersion: metadata.schemaVersion };
  } catch {
    return { status: 'failed', schemaVersion: metadata.schemaVersion };
  }
}

interface ResolvedSourceIdentity {
  docType: string;
  expectedRelations: readonly SyntheticMonitorExpectedRelation[];
  graphNodeId: string | null;
  logicalSourceId: string;
  rawDocumentId: string | null;
  sourceType: string;
  sourceVersion: string;
}

function resolveSourceIdentity(source: SyntheticMonitorSourceInput): ResolvedSourceIdentity {
  if (source.kind === 'gmail') {
    return {
      sourceType: 'gmail',
      docType: 'email',
      logicalSourceId: gmailLogicalSourceId(source.threadId),
      sourceVersion: gmailSourceVersion(source.expectedMessageId),
      expectedRelations: source.expectedRelations ?? [],
      rawDocumentId: null,
      graphNodeId: null,
    };
  }
  if (source.kind === 'drive') {
    return {
      sourceType: 'drive',
      docType: 'drive_doc',
      logicalSourceId: driveLogicalSourceId(source.fileId),
      sourceVersion: driveSourceVersion(source.expectedRevisionId),
      expectedRelations: source.expectedRelations ?? [],
      rawDocumentId: null,
      graphNodeId: null,
    };
  }
  if (source.kind === 'github') {
    const githubKind = source.resourceType === 'pull_request' ? 'pull_request' : 'issue';
    return {
      sourceType: 'github',
      docType: githubKind,
      logicalSourceId: githubLogicalSourceId({
        kind: githubKind,
        number: source.number,
        repository: source.repository,
      }),
      sourceVersion: source.expectedVersion,
      expectedRelations: source.expectedRelations ?? [],
      rawDocumentId: null,
      graphNodeId: null,
    };
  }
  return {
    sourceType: 'web',
    docType: 'web_page',
    logicalSourceId: webLogicalSourceId(source.canonicalUrl),
    sourceVersion: webSourceVersion(source.expectedContentHash),
    expectedRelations: source.expectedRelations ?? [],
    rawDocumentId: null,
    graphNodeId: null,
  };
}

function evaluateExpectedRelations(
  expected: readonly SyntheticMonitorExpectedRelation[],
  actual: Readonly<Record<SyntheticMonitorRelationType, number>>,
): SyntheticMonitorStageStatus {
  if (expected.length === 0) return 'ok';
  for (const relation of expected) {
    if ((actual[relation.type] ?? 0) < relation.minCount) return 'failed';
  }
  return 'ok';
}

function emptyRelationCounts(): Readonly<Record<SyntheticMonitorRelationType, number>> {
  return normalizeRelationCounts({});
}

function normalizeRelationCounts(
  counts: Readonly<Record<string, number>>,
): Readonly<Record<SyntheticMonitorRelationType, number>> {
  const normalized = Object.fromEntries(
    SYNTHETIC_MONITOR_RELATION_TYPES.map((type) => [type, 0]),
  ) as Record<SyntheticMonitorRelationType, number>;
  for (const type of SYNTHETIC_MONITOR_RELATION_TYPES) {
    normalized[type] = counts[type] ?? 0;
  }
  return normalized;
}

function failedSourceObservation(
  index: number,
  kind: SyntheticMonitorSourceKind,
): SyntheticMonitorSourceObservation {
  const emptyRelations = emptyRelationCounts();
  const failed = { status: 'failed' as const };
  return {
    index,
    kind,
    raw: failed,
    currentDocument: failed,
    chunks: { status: 'failed', embeddingComplete: false },
    graph: { status: 'failed', documentNodePresent: false, relations: emptyRelations },
    ...(kind === 'web'
      ? {}
      : { schedule: { status: 'failed', enabled: false, retryCount: 0, nextRunDue: false } }),
  };
}

function failedReportObservation(): SyntheticMonitorReportObservation {
  return {
    schedule: { status: 'failed', frequency: null, nextRunDue: false },
    periodRun: { status: 'failed', runStatus: null },
    artifact: { status: 'failed', schemaVersion: null },
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export { SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS, SYNTHETIC_MONITOR_STATEMENT_TIMEOUT_MS };
