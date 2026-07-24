/**
 * Client-safe Synthetic Monitor API contract shared by Mastra routes and tests.
 *
 * This module must not import postgres, SQL repositories, or Next.js server-only code.
 */

export const SYNTHETIC_MONITOR_CONTRACT_VERSION = 'synthetic-monitor-v1' as const;
export const SYNTHETIC_MONITOR_MAX_BODY_BYTES = 64 * 1024;
export const SYNTHETIC_MONITOR_MAX_SOURCES = 20;
export const SYNTHETIC_MONITOR_MAX_STRING_LENGTH = 512;
export const SYNTHETIC_MONITOR_MAX_URL_LENGTH = 2048;
export const SYNTHETIC_MONITOR_MAX_REPOSITORY_LENGTH = 256;
export const SYNTHETIC_MONITOR_MAX_GITHUB_NUMBER = 999_999;
export const SYNTHETIC_MONITOR_MAX_EXPECTED_RELATIONS = 10;
export const SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT = 1_000_000;
export const SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS = 30_000;
export const SYNTHETIC_MONITOR_STATEMENT_TIMEOUT_MS = 5_000;
export const SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const SYNTHETIC_MONITOR_GITHUB_EXPECTED_VERSION_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z:[a-f0-9]{64}$/;
export const SYNTHETIC_MONITOR_REPORT_SCHEDULE_FREQUENCIES = [
  'none',
  'weekly',
  'monthly',
  'annually',
] as const;
export const SYNTHETIC_MONITOR_PERIOD_RUN_STATUSES = [
  'pending',
  'running',
  'retry_wait',
  'succeeded',
  'skipped',
  'retry_exhausted',
] as const;

export const SYNTHETIC_MONITOR_RELATION_TYPES = [
  'AUTHORED',
  'COMMENTED_ON',
  'MENTIONS',
  'OWNS',
  'REPLY_TO',
  'RELATED_TO',
  'REVIEWED',
  'SAME_AS',
  'SENT',
] as const;

export type SyntheticMonitorRelationType = (typeof SYNTHETIC_MONITOR_RELATION_TYPES)[number];
export type SyntheticMonitorStageStatus = 'failed' | 'not_found' | 'ok' | 'pending';
export type SyntheticMonitorSourceKind = 'drive' | 'github' | 'gmail' | 'web';
export type SyntheticMonitorReportFrequency = 'annually' | 'monthly' | 'weekly';

export interface SyntheticMonitorExpectedRelation {
  readonly minCount: number;
  readonly type: SyntheticMonitorRelationType;
}

export interface SyntheticMonitorGmailSource {
  readonly expectedMessageId: string;
  readonly expectedRelations?: readonly SyntheticMonitorExpectedRelation[];
  readonly kind: 'gmail';
  readonly threadId: string;
}

export interface SyntheticMonitorDriveSource {
  readonly expectedRelations?: readonly SyntheticMonitorExpectedRelation[];
  readonly expectedRevisionId: string;
  readonly fileId: string;
  readonly kind: 'drive';
}

export interface SyntheticMonitorGitHubSource {
  readonly expectedRelations?: readonly SyntheticMonitorExpectedRelation[];
  readonly expectedVersion: string;
  readonly kind: 'github';
  readonly number: number;
  readonly repository: string;
  readonly resourceType: 'issue' | 'pull_request';
}

export interface SyntheticMonitorWebSource {
  readonly canonicalUrl: string;
  readonly expectedContentHash: string;
  readonly expectedRelations?: readonly SyntheticMonitorExpectedRelation[];
  readonly kind: 'web';
}

export type SyntheticMonitorSourceInput =
  | SyntheticMonitorDriveSource
  | SyntheticMonitorGitHubSource
  | SyntheticMonitorGmailSource
  | SyntheticMonitorWebSource;

export interface SyntheticMonitorReportInput {
  readonly frequency: SyntheticMonitorReportFrequency;
  readonly periodEnd: string;
  readonly periodStart: string;
}

export interface SyntheticMonitorRequest {
  readonly projectSlug: string;
  readonly report?: SyntheticMonitorReportInput;
  readonly sources: readonly SyntheticMonitorSourceInput[];
}

export interface SyntheticMonitorStageObservation {
  readonly status: SyntheticMonitorStageStatus;
}

export interface SyntheticMonitorChunkStageObservation extends SyntheticMonitorStageObservation {
  readonly embeddingComplete: boolean;
}

export interface SyntheticMonitorGraphStageObservation extends SyntheticMonitorStageObservation {
  readonly documentNodePresent: boolean;
  readonly relations: Readonly<Record<SyntheticMonitorRelationType, number>>;
}

export interface SyntheticMonitorScheduleStageObservation extends SyntheticMonitorStageObservation {
  readonly enabled: boolean;
  readonly nextRunDue: boolean;
  readonly retryCount: number;
}

export interface SyntheticMonitorSourceObservation {
  readonly chunks: SyntheticMonitorChunkStageObservation;
  readonly currentDocument: SyntheticMonitorStageObservation;
  readonly graph: SyntheticMonitorGraphStageObservation;
  readonly index: number;
  readonly kind: SyntheticMonitorSourceKind;
  readonly raw: SyntheticMonitorStageObservation;
  readonly schedule?: SyntheticMonitorScheduleStageObservation;
}

export interface SyntheticMonitorReportArtifactObservation
  extends SyntheticMonitorStageObservation {
  readonly schemaVersion: string | null;
}

export interface SyntheticMonitorReportObservation {
  readonly artifact: SyntheticMonitorReportArtifactObservation;
  readonly periodRun: SyntheticMonitorStageObservation & {
    readonly runStatus: string | null;
  };
  readonly schedule: SyntheticMonitorStageObservation & {
    readonly frequency: string | null;
    readonly nextRunDue: boolean;
  };
}

export interface SyntheticMonitorResponse {
  readonly contractVersion: typeof SYNTHETIC_MONITOR_CONTRACT_VERSION;
  readonly observations: readonly SyntheticMonitorSourceObservation[];
  readonly projectSlug: string;
  readonly report?: SyntheticMonitorReportObservation;
}

export class SyntheticMonitorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticMonitorRequestError';
  }
}

/**
 * Parses comma-separated service account emails from monitor configuration.
 *
 * @param value - Raw environment variable value.
 * @returns Normalized lowercase email allowlist entries.
 */
export function parseSyntheticMonitorServiceAccounts(value: string): readonly string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('SYNTHETIC_MONITOR_SERVICE_ACCOUNTS must list at least one email.');
  }
  for (const entry of entries) {
    if (!entry.endsWith('.gserviceaccount.com')) {
      throw new Error(
        'SYNTHETIC_MONITOR_SERVICE_ACCOUNTS must list Google service account emails.',
      );
    }
    if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(entry)) {
      throw new Error(
        'SYNTHETIC_MONITOR_SERVICE_ACCOUNTS contains an invalid service account email.',
      );
    }
  }
  return entries;
}

/**
 * Parses comma-separated dedicated project slugs from monitor configuration.
 *
 * @param value - Raw environment variable value.
 * @returns Normalized project slug allowlist entries.
 */
export function parseSyntheticMonitorProjectSlugs(value: string): readonly string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error('SYNTHETIC_MONITOR_PROJECT_SLUGS must list at least one project slug.');
  }
  for (const entry of entries) {
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(entry)) {
      throw new Error('SYNTHETIC_MONITOR_PROJECT_SLUGS contains an invalid project slug.');
    }
  }
  return entries;
}

/**
 * Parses and validates a Synthetic Monitor observations request body.
 *
 * @param body - Parsed JSON request body.
 * @param bodyByteLength - Raw request body size in bytes.
 * @returns A bounded request contract.
 */
export function parseSyntheticMonitorRequest(
  body: unknown,
  bodyByteLength: number,
): SyntheticMonitorRequest {
  if (bodyByteLength > SYNTHETIC_MONITOR_MAX_BODY_BYTES) {
    throw new SyntheticMonitorRequestError('request body exceeds 64KiB limit.');
  }
  if (!isRecord(body)) {
    throw new SyntheticMonitorRequestError('request body must be a JSON object.');
  }
  assertOnlyKnownKeys(body, ['projectSlug', 'sources', 'report']);
  const projectSlug = requireBoundedString(body.projectSlug, 'projectSlug', 128);
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(projectSlug)) {
    throw new SyntheticMonitorRequestError('projectSlug must use lowercase slug format.');
  }
  const sources = parseSources(body.sources);
  const report = body.report === undefined ? undefined : parseReport(body.report);
  return { projectSlug, sources, ...(report ? { report } : {}) };
}

function parseSources(value: unknown): readonly SyntheticMonitorSourceInput[] {
  if (!Array.isArray(value)) {
    throw new SyntheticMonitorRequestError('sources must be an array.');
  }
  if (value.length === 0) {
    throw new SyntheticMonitorRequestError('sources must include at least one entry.');
  }
  if (value.length > SYNTHETIC_MONITOR_MAX_SOURCES) {
    throw new SyntheticMonitorRequestError(
      `sources must not exceed ${SYNTHETIC_MONITOR_MAX_SOURCES} items.`,
    );
  }
  return value.map((entry, index) => parseSource(entry, index));
}

function parseSource(value: unknown, index: number): SyntheticMonitorSourceInput {
  if (!isRecord(value)) {
    throw new SyntheticMonitorRequestError(`sources[${index}] must be an object.`);
  }
  const kind = requireString(value.kind, `sources[${index}].kind`);
  const expectedRelations = parseExpectedRelations(value.expectedRelations, index);
  if (kind === 'gmail') {
    assertOnlyKnownKeys(value, ['kind', 'threadId', 'expectedMessageId', 'expectedRelations']);
    return {
      kind,
      threadId: requireBoundedString(value.threadId, `sources[${index}].threadId`),
      expectedMessageId: requireBoundedString(
        value.expectedMessageId,
        `sources[${index}].expectedMessageId`,
      ),
      ...(expectedRelations ? { expectedRelations } : {}),
    };
  }
  if (kind === 'drive') {
    assertOnlyKnownKeys(value, ['kind', 'fileId', 'expectedRevisionId', 'expectedRelations']);
    return {
      kind,
      fileId: requireBoundedString(value.fileId, `sources[${index}].fileId`),
      expectedRevisionId: requireBoundedString(
        value.expectedRevisionId,
        `sources[${index}].expectedRevisionId`,
      ),
      ...(expectedRelations ? { expectedRelations } : {}),
    };
  }
  if (kind === 'github') {
    assertOnlyKnownKeys(value, [
      'kind',
      'repository',
      'resourceType',
      'number',
      'expectedVersion',
      'expectedRelations',
    ]);
    const resourceType = requireString(value.resourceType, `sources[${index}].resourceType`);
    if (resourceType !== 'issue' && resourceType !== 'pull_request') {
      throw new SyntheticMonitorRequestError(`sources[${index}].resourceType is invalid.`);
    }
    const number = requireGitHubNumber(value.number, `sources[${index}].number`);
    const repository = requireRepository(value.repository, `sources[${index}].repository`);
    return {
      kind,
      repository,
      resourceType,
      number,
      expectedVersion: requireGitHubExpectedVersion(
        value.expectedVersion,
        `sources[${index}].expectedVersion`,
      ),
      ...(expectedRelations ? { expectedRelations } : {}),
    };
  }
  if (kind === 'web') {
    assertOnlyKnownKeys(value, [
      'kind',
      'canonicalUrl',
      'expectedContentHash',
      'expectedRelations',
    ]);
    return {
      kind,
      canonicalUrl: requireUrl(value.canonicalUrl, `sources[${index}].canonicalUrl`),
      expectedContentHash: requireSha256(
        value.expectedContentHash,
        `sources[${index}].expectedContentHash`,
      ),
      ...(expectedRelations ? { expectedRelations } : {}),
    };
  }
  throw new SyntheticMonitorRequestError(`sources[${index}].kind is invalid.`);
}

function parseExpectedRelations(
  value: unknown,
  index: number,
): readonly SyntheticMonitorExpectedRelation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SyntheticMonitorRequestError(`sources[${index}].expectedRelations must be an array.`);
  }
  if (value.length > SYNTHETIC_MONITOR_MAX_EXPECTED_RELATIONS) {
    throw new SyntheticMonitorRequestError(
      `sources[${index}].expectedRelations exceeds ${SYNTHETIC_MONITOR_MAX_EXPECTED_RELATIONS} items.`,
    );
  }
  return value.map((entry, relationIndex) => {
    if (!isRecord(entry)) {
      throw new SyntheticMonitorRequestError(
        `sources[${index}].expectedRelations[${relationIndex}] must be an object.`,
      );
    }
    assertOnlyKnownKeys(entry, ['type', 'minCount']);
    const type = requireString(
      entry.type,
      `sources[${index}].expectedRelations[${relationIndex}].type`,
    );
    if (!SYNTHETIC_MONITOR_RELATION_TYPES.includes(type as SyntheticMonitorRelationType)) {
      throw new SyntheticMonitorRequestError(
        `sources[${index}].expectedRelations[${relationIndex}].type is invalid.`,
      );
    }
    const minCount = requireRelationMinCount(
      entry.minCount,
      `sources[${index}].expectedRelations[${relationIndex}].minCount`,
    );
    return { type: type as SyntheticMonitorRelationType, minCount };
  });
}

function parseReport(value: unknown): SyntheticMonitorReportInput {
  if (!isRecord(value)) {
    throw new SyntheticMonitorRequestError('report must be an object.');
  }
  assertOnlyKnownKeys(value, ['frequency', 'periodStart', 'periodEnd']);
  const frequency = requireString(value.frequency, 'report.frequency');
  if (frequency !== 'weekly' && frequency !== 'monthly' && frequency !== 'annually') {
    throw new SyntheticMonitorRequestError('report.frequency is invalid.');
  }
  const periodStart = requireDate(value.periodStart, 'report.periodStart');
  const periodEnd = requireDate(value.periodEnd, 'report.periodEnd');
  if (periodStart > periodEnd) {
    throw new SyntheticMonitorRequestError(
      'report.periodStart must be on or before report.periodEnd.',
    );
  }
  return {
    frequency,
    periodStart,
    periodEnd,
  };
}

function requireDate(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new SyntheticMonitorRequestError(`${field} must use YYYY-MM-DD.`);
  }
  const [yearText, monthText, dayText] = text.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new SyntheticMonitorRequestError(`${field} must be a valid calendar date.`);
  }
  return text;
}

function requireGitHubExpectedVersion(value: unknown, field: string): string {
  const text = requireBoundedString(value, field);
  if (!SYNTHETIC_MONITOR_GITHUB_EXPECTED_VERSION_PATTERN.test(text)) {
    throw new SyntheticMonitorRequestError(
      `${field} must use <GitHub ISO timestamp>Z:<sha256> format.`,
    );
  }
  return text;
}

function requireRelationMinCount(value: unknown, field: string): number {
  const minCount = requireNonNegativeInteger(value, field);
  if (minCount > SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT) {
    throw new SyntheticMonitorRequestError(
      `${field} must not exceed ${SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT}.`,
    );
  }
  return minCount;
}

function requireRepository(value: unknown, field: string): string {
  const text = requireBoundedString(value, field, SYNTHETIC_MONITOR_MAX_REPOSITORY_LENGTH);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    throw new SyntheticMonitorRequestError(`${field} must use owner/repo format.`);
  }
  return text.toLowerCase();
}

function requireGitHubNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new SyntheticMonitorRequestError(`${field} must be a positive integer.`);
  }
  if (value > SYNTHETIC_MONITOR_MAX_GITHUB_NUMBER) {
    throw new SyntheticMonitorRequestError(`${field} exceeds supported range.`);
  }
  return value;
}

function requireUrl(value: unknown, field: string): string {
  const text = requireBoundedString(value, field, SYNTHETIC_MONITOR_MAX_URL_LENGTH);
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SyntheticMonitorRequestError(`${field} must use http or https.`);
    }
    return text;
  } catch {
    throw new SyntheticMonitorRequestError(`${field} must be a valid URL.`);
  }
}

function requireSha256(value: unknown, field: string): string {
  const text = requireBoundedString(value, field);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new SyntheticMonitorRequestError(`${field} must be a lowercase sha256 hex digest.`);
  }
  return text;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number = SYNTHETIC_MONITOR_MAX_STRING_LENGTH,
): string {
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw new SyntheticMonitorRequestError(`${field} exceeds ${maxLength} characters.`);
  }
  return text;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SyntheticMonitorRequestError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SyntheticMonitorRequestError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function assertOnlyKnownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SyntheticMonitorRequestError(`unknown field: ${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps route and service failures to safe client-facing error text.
 *
 * @param error - Caught route or service error.
 * @returns A short error summary without secrets or provider payloads.
 */
export function safeSyntheticMonitorRouteError(error: unknown): string {
  if (error instanceof SyntheticMonitorRequestError) {
    return error.message;
  }
  if (error instanceof Error) {
    if (error.message === 'monitor authentication is required') return error.message;
    if (error.message === 'monitor authentication failed') return error.message;
    if (error.message === 'monitor project scope denied') return error.message;
    if (error.message === 'SYNTHETIC_MONITOR_OIDC_AUDIENCE is required') return error.message;
    if (error.message.startsWith('SYNTHETIC_MONITOR_')) return error.message;
  }
  return 'synthetic monitor request failed';
}
