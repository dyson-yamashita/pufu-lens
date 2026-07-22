import type { GeneratedReportContent } from './report-provider.ts';
import { containsPrivateText, redactText } from './report-public-redaction.ts';
import {
  normalizeReportWhitespace,
  truncateCodePoints,
  truncateReportText,
} from './report-text.ts';

export const PROJECT_OVERVIEW_SCHEMA_VERSION = 'project-overview-v1' as const;
export const PROJECT_OVERVIEW_STATUS_SUMMARY_MAX_CODE_POINTS = 400;
export const PROJECT_OVERVIEW_ITEM_TITLE_MAX_CODE_POINTS = 120;
export const PROJECT_OVERVIEW_ITEM_DESCRIPTION_MAX_CODE_POINTS = 300;
export const PROJECT_OVERVIEW_NEXT_ACTION_MAX_CODE_POINTS = 300;
export const PROJECT_OVERVIEW_MAX_ASSETS = 5;
export const PROJECT_OVERVIEW_MAX_ISSUES = 5;

export interface ProjectOverviewAssetV1 {
  readonly description: string;
  readonly title: string;
}

export interface ProjectOverviewIssueV1 {
  readonly description: string;
  readonly next_action: string;
  readonly title: string;
}

export interface ProjectOverviewV1 {
  readonly assets: readonly ProjectOverviewAssetV1[];
  readonly issues: readonly ProjectOverviewIssueV1[];
  readonly schema_version: typeof PROJECT_OVERVIEW_SCHEMA_VERSION;
  readonly status_summary: string;
}

export type PublicProjectOverviewV1 = ProjectOverviewV1;

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

/**
 * Validates a stored or generated project overview payload.
 */
export function validateProjectOverview(value: unknown): asserts value is ProjectOverviewV1 {
  if (!isRecord(value)) {
    throw new Error('Project overview must be an object.');
  }
  if (value.schema_version !== PROJECT_OVERVIEW_SCHEMA_VERSION) {
    throw new Error('Project overview schema_version must be project-overview-v1.');
  }
  if (typeof value.status_summary !== 'string' || value.status_summary.length === 0) {
    throw new Error('Project overview status_summary must be a non-empty string.');
  }
  validateOverviewString(
    value.status_summary,
    'status_summary',
    PROJECT_OVERVIEW_STATUS_SUMMARY_MAX_CODE_POINTS,
  );
  if (!Array.isArray(value.assets)) {
    throw new Error('Project overview assets must be an array.');
  }
  if (value.assets.length > PROJECT_OVERVIEW_MAX_ASSETS) {
    throw new Error('Project overview assets exceed item limit.');
  }
  for (const asset of value.assets) {
    validateOverviewAsset(asset);
  }
  if (!Array.isArray(value.issues)) {
    throw new Error('Project overview issues must be an array.');
  }
  if (value.issues.length > PROJECT_OVERVIEW_MAX_ISSUES) {
    throw new Error('Project overview issues exceed item limit.');
  }
  for (const issue of value.issues) {
    validateOverviewIssue(issue);
  }
  assertPublicSafeOverview(value as unknown as ProjectOverviewV1);
}

/**
 * Normalizes provider output into a public-safe project overview payload.
 */
export function normalizeProjectOverview(value: unknown): ProjectOverviewV1 {
  const statusSummary = sanitizeOverviewField(
    readOverviewString(value, 'status_summary'),
    PROJECT_OVERVIEW_STATUS_SUMMARY_MAX_CODE_POINTS,
  );
  if (!statusSummary) {
    throw new Error('Project overview status_summary is empty after normalization.');
  }
  const assets = normalizeOverviewAssets(readOverviewArray(value, 'assets'));
  const issues = normalizeOverviewIssues(readOverviewArray(value, 'issues'));
  const overview: ProjectOverviewV1 = {
    assets,
    issues,
    schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
    status_summary: statusSummary,
  };
  assertPublicSafeOverview(overview);
  validateProjectOverview(overview);
  return overview;
}

/**
 * Builds a deterministic project overview from extractive report content.
 */
export function buildExtractiveProjectOverview(
  generated: Pick<GeneratedReportContent, 'sections' | 'summary'>,
): ProjectOverviewV1 {
  const progressSection = generated.sections.find((section) => section.id === 'progress');
  const risksSection = generated.sections.find((section) => section.id === 'risks');
  const assetLines = markdownBullets(progressSection?.markdown ?? '').slice(
    0,
    PROJECT_OVERVIEW_MAX_ASSETS,
  );
  const issueLines = markdownBullets(risksSection?.markdown ?? '').slice(
    0,
    PROJECT_OVERVIEW_MAX_ISSUES,
  );
  return normalizeProjectOverview({
    assets: assetLines.map((line, index) => ({
      description: line,
      title: `アセット ${index + 1}`,
    })),
    issues: issueLines.map((line, index) => ({
      description: line,
      next_action: '状況確認と次の判断材料の整理',
      title: `課題 ${index + 1}`,
    })),
    schema_version: PROJECT_OVERVIEW_SCHEMA_VERSION,
    status_summary: generated.summary,
  });
}

/**
 * Projects a stored overview into a public-safe view for anonymous display.
 */
export function toPublicProjectOverview(overview: ProjectOverviewV1): PublicProjectOverviewV1 {
  return normalizeProjectOverview(overview);
}

function validateOverviewAsset(value: unknown): asserts value is ProjectOverviewAssetV1 {
  if (!isRecord(value)) {
    throw new Error('Project overview asset must be an object.');
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    throw new Error('Project overview asset title must be a non-empty string.');
  }
  if (typeof value.description !== 'string' || value.description.length === 0) {
    throw new Error('Project overview asset description must be a non-empty string.');
  }
  validateOverviewString(value.title, 'asset title', PROJECT_OVERVIEW_ITEM_TITLE_MAX_CODE_POINTS);
  validateOverviewString(
    value.description,
    'asset description',
    PROJECT_OVERVIEW_ITEM_DESCRIPTION_MAX_CODE_POINTS,
  );
}

function validateOverviewIssue(value: unknown): asserts value is ProjectOverviewIssueV1 {
  if (!isRecord(value)) {
    throw new Error('Project overview issue must be an object.');
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    throw new Error('Project overview issue title must be a non-empty string.');
  }
  if (typeof value.description !== 'string' || value.description.length === 0) {
    throw new Error('Project overview issue description must be a non-empty string.');
  }
  if (typeof value.next_action !== 'string' || value.next_action.length === 0) {
    throw new Error('Project overview issue next_action must be a non-empty string.');
  }
  validateOverviewString(value.title, 'issue title', PROJECT_OVERVIEW_ITEM_TITLE_MAX_CODE_POINTS);
  validateOverviewString(
    value.description,
    'issue description',
    PROJECT_OVERVIEW_ITEM_DESCRIPTION_MAX_CODE_POINTS,
  );
  validateOverviewString(
    value.next_action,
    'issue next_action',
    PROJECT_OVERVIEW_NEXT_ACTION_MAX_CODE_POINTS,
  );
}

function validateOverviewString(value: string, field: string, maxCodePoints: number): void {
  if ([...value].length > maxCodePoints) {
    throw new Error(`Project overview ${field} exceeds code point limit.`);
  }
  if (containsUnsafeOverviewText(value)) {
    throw new Error(`Project overview ${field} contains private text.`);
  }
}

function normalizeOverviewAssets(value: unknown): readonly ProjectOverviewAssetV1[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeOverviewAsset(item))
    .filter((item): item is ProjectOverviewAssetV1 => item !== undefined)
    .slice(0, PROJECT_OVERVIEW_MAX_ASSETS);
}

function normalizeOverviewIssues(value: unknown): readonly ProjectOverviewIssueV1[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeOverviewIssue(item))
    .filter((item): item is ProjectOverviewIssueV1 => item !== undefined)
    .slice(0, PROJECT_OVERVIEW_MAX_ISSUES);
}

function normalizeOverviewAsset(value: unknown): ProjectOverviewAssetV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const title = sanitizeOverviewField(
    typeof value.title === 'string' ? value.title : '',
    PROJECT_OVERVIEW_ITEM_TITLE_MAX_CODE_POINTS,
  );
  const description = sanitizeOverviewField(
    typeof value.description === 'string' ? value.description : '',
    PROJECT_OVERVIEW_ITEM_DESCRIPTION_MAX_CODE_POINTS,
  );
  if (!title || !description) {
    return undefined;
  }
  return { description, title };
}

function normalizeOverviewIssue(value: unknown): ProjectOverviewIssueV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const title = sanitizeOverviewField(
    typeof value.title === 'string' ? value.title : '',
    PROJECT_OVERVIEW_ITEM_TITLE_MAX_CODE_POINTS,
  );
  const description = sanitizeOverviewField(
    typeof value.description === 'string' ? value.description : '',
    PROJECT_OVERVIEW_ITEM_DESCRIPTION_MAX_CODE_POINTS,
  );
  const nextAction = sanitizeOverviewField(
    typeof value.next_action === 'string' ? value.next_action : '',
    PROJECT_OVERVIEW_NEXT_ACTION_MAX_CODE_POINTS,
  );
  if (!title || !description || !nextAction) {
    return undefined;
  }
  return { description, next_action: nextAction, title };
}

function sanitizeOverviewField(value: string, maxCodePoints: number): string {
  const normalized = truncateCodePoints(
    redactText(normalizeReportWhitespace(value)),
    maxCodePoints,
  );
  if (!normalized || containsUnsafeOverviewText(normalized)) {
    return '';
  }
  return normalized;
}

function containsUnsafeOverviewText(value: string): boolean {
  if (containsPrivateText(value)) {
    return true;
  }
  if (UUID_PATTERN.test(value)) {
    return true;
  }
  if (/\b(?:document_id|canonical_uri|storage_uri|raw_document_id)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:secret|api[_-]?key|token)(?:\s+|=|:)\s*\S+/i.test(value)) {
    return true;
  }
  return false;
}

function assertPublicSafeOverview(overview: ProjectOverviewV1): void {
  const serialized = JSON.stringify(overview);
  if (containsUnsafeOverviewText(serialized)) {
    throw new Error('Project overview contains private text.');
  }
  if (
    'document_id' in overview ||
    'canonical_uri' in overview ||
    'storage_uri' in overview ||
    'project_id' in overview
  ) {
    throw new Error('Project overview must not include private identifiers.');
  }
}

function markdownBullets(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => truncateReportText(line.replace(/^[-*]\s+/, '').trim(), 300))
    .filter(Boolean);
}

function readOverviewString(value: unknown, field: string): string {
  if (!isRecord(value)) {
    return '';
  }
  const raw = value[field];
  return typeof raw === 'string' ? raw : '';
}

function readOverviewArray(value: unknown, field: string): unknown {
  if (!isRecord(value)) {
    return [];
  }
  return value[field];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
