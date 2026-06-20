import { createHash } from 'node:crypto';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import type { PrivateReportJsonV1, PrivateReportSection, ReportPeriod } from './report-schema.ts';

export interface PublicReportSource {
  readonly label: string;
  readonly public_source_id: string;
}

export interface PublicReportSection {
  readonly id: PrivateReportSection['id'];
  readonly items?: readonly Record<string, unknown>[];
  readonly markdown: string;
  readonly metrics?: Record<string, number>;
  readonly sources?: readonly PublicReportSource[];
  readonly title: string;
}

export interface PublicReportJsonV1 {
  readonly period: ReportPeriod;
  readonly published_at: string;
  readonly report_id: string;
  readonly schema_version: 'public-v1';
  readonly sections: readonly PublicReportSection[];
  readonly summary: string;
  readonly title: string;
}

export interface PublicContextBundleV1 {
  readonly report_id: string;
  readonly schema_version: 'public-context-v1';
  readonly sections: ReadonlyArray<{
    readonly id: PrivateReportSection['id'];
    readonly markdown: string;
    readonly public_source_ids: readonly string[];
    readonly title: string;
  }>;
}

export interface PublicReportManifestV1 {
  readonly artifact_version: string;
  readonly etag: string;
  readonly project_slug: string;
  readonly public_context_bundle_uri: string;
  readonly public_report_uri: string;
  readonly published_at: string;
  readonly report_id: string;
  readonly revoked_at: string | null;
  readonly schema_version: 'public-report-manifest-v1';
}

export interface PublicProjectManifestV1 {
  readonly project_slug: string;
  readonly published_at: string | null;
  readonly schema_version: 'public-project-manifest-v1';
  readonly visibility: 'private' | 'public';
}

export async function readPublicReportManifest(input: {
  readonly projectSlug: string;
  readonly reportId: string;
  readonly storage: ObjectStorage;
}): Promise<PublicReportManifestV1 | undefined> {
  if (!isSafePublicReportLocator(input)) {
    return undefined;
  }
  const path = publicReportManifestPath(input.projectSlug, input.reportId);
  if (!(await input.storage.exists(path))) {
    return undefined;
  }
  const manifest = JSON.parse(await input.storage.getText(path)) as unknown;
  validatePublicReportManifest(manifest, input.projectSlug, input.reportId);
  return manifest;
}

export async function writePublicProjectManifest(input: {
  readonly projectSlug: string;
  readonly publishedAt?: string | null;
  readonly storage: ObjectStorage;
  readonly visibility: 'private' | 'public';
}): Promise<PublicProjectManifestV1> {
  if (!PROJECT_SLUG_PATTERN.test(input.projectSlug)) {
    throw new Error(`Invalid project slug: ${input.projectSlug}`);
  }
  const manifest: PublicProjectManifestV1 = {
    project_slug: input.projectSlug,
    published_at:
      input.visibility === 'public' ? (input.publishedAt ?? new Date().toISOString()) : null,
    schema_version: 'public-project-manifest-v1',
    visibility: input.visibility,
  };
  await input.storage.put(
    publicProjectManifestPath(input.projectSlug),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      cacheControl: 'no-store',
      contentType: 'application/json; charset=utf-8',
    },
  );
  return manifest;
}

export async function isProjectPublic(input: {
  readonly projectSlug: string;
  readonly storage: ObjectStorage;
}): Promise<boolean> {
  const manifest = await readPublicProjectManifest(input);
  return manifest?.visibility === 'public';
}

export function buildPublicReport(
  report: PrivateReportJsonV1,
  publishedAt: string,
): PublicReportJsonV1 {
  return {
    period: report.period,
    published_at: publishedAt,
    report_id: report.report_id,
    schema_version: 'public-v1',
    sections: report.sections.map((section) => ({
      id: section.id,
      items: redactItems(section.items),
      markdown: redactText(section.markdown),
      metrics: section.metrics,
      sources: section.sources?.map((source, index) => ({
        label: publicSourceLabel(source.doc_type, index),
        public_source_id: `src_${section.id}_${String(index + 1).padStart(3, '0')}`,
      })),
      title: redactText(section.title),
    })),
    summary: redactText(report.summary),
    title: redactText(report.title),
  };
}

export function buildPublicContextBundle(report: PublicReportJsonV1): PublicContextBundleV1 {
  return {
    report_id: report.report_id,
    schema_version: 'public-context-v1',
    sections: report.sections.map((section) => ({
      id: section.id,
      markdown: section.markdown,
      public_source_ids: section.sources?.map((source) => source.public_source_id) ?? [],
      title: section.title,
    })),
  };
}

export function buildArtifactVersion(report: PublicReportJsonV1, publishedAt: string): string {
  const time = publishedAt.replace(/[^0-9]/g, '').slice(0, 14);
  return `${time}-${digestJson(report).slice(0, 12)}`;
}

export function publicReportManifestPath(projectSlug: string, reportId: string): string {
  return `${projectSlug}/reports/public/${reportId}/manifest.json`;
}

export function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function isSafePublicReportLocator(input: {
  readonly projectSlug: string;
  readonly reportId: string;
}): boolean {
  return (
    PROJECT_SLUG_PATTERN.test(input.projectSlug) && PUBLIC_REPORT_ID_PATTERN.test(input.reportId)
  );
}

export function validatePublicReportJson(value: unknown): asserts value is PublicReportJsonV1 {
  if (!isRecord(value)) {
    throw new Error('Public report JSON must be an object.');
  }
  if (value.schema_version !== 'public-v1') {
    throw new Error('Public report schema_version must be public-v1.');
  }
  for (const key of ['report_id', 'title', 'published_at', 'summary']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Public report ${key} must be a non-empty string.`);
    }
  }
  if ('project_id' in value || 'document_id' in value || 'storage_uri' in value) {
    throw new Error('Public report must not include private identifiers.');
  }
  if (
    !isRecord(value.period) ||
    typeof value.period.start !== 'string' ||
    typeof value.period.end !== 'string'
  ) {
    throw new Error('Public report period must include start and end.');
  }
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new Error('Public report sections must be a non-empty array.');
  }
  const serialized = JSON.stringify(value);
  if (containsPrivateText(serialized)) {
    throw new Error('Public report contains private text.');
  }
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== 'string' || typeof section.title !== 'string') {
      throw new Error('Public report section must include id and title.');
    }
    if (typeof section.markdown !== 'string') {
      throw new Error(`Public report section ${section.id} markdown must be a string.`);
    }
    if (section.sources !== undefined && !Array.isArray(section.sources)) {
      throw new Error('Public report section sources must be an array.');
    }
    if (section.sources) {
      for (const source of section.sources) {
        if (!isRecord(source) || typeof source.public_source_id !== 'string') {
          throw new Error('Public report source must include public_source_id.');
        }
        if ('document_id' in source || 'canonical_uri' in source || 'snippet' in source) {
          throw new Error('Public report source must not include private source fields.');
        }
      }
    }
  }
}

export function validatePublicContextBundle(
  value: unknown,
  report: PublicReportJsonV1,
): asserts value is PublicContextBundleV1 {
  if (!isRecord(value)) {
    throw new Error('Public context bundle must be an object.');
  }
  if (value.schema_version !== 'public-context-v1' || value.report_id !== report.report_id) {
    throw new Error('Public context bundle target is invalid.');
  }
  if (!Array.isArray(value.sections)) {
    throw new Error('Public context bundle sections must be an array.');
  }
  const reportSectionIds = new Set(report.sections.map((section) => section.id));
  const publicSourceIds = new Set(
    report.sections.flatMap(
      (section) => section.sources?.map((source) => source.public_source_id) ?? [],
    ),
  );
  const serialized = JSON.stringify(value);
  if (containsPrivateText(serialized)) {
    throw new Error('Public context bundle contains private text.');
  }
  for (const section of value.sections) {
    if (
      !isRecord(section) ||
      typeof section.id !== 'string' ||
      typeof section.markdown !== 'string' ||
      typeof section.title !== 'string' ||
      !Array.isArray(section.public_source_ids)
    ) {
      throw new Error('Public context bundle section is invalid.');
    }
    if (!reportSectionIds.has(section.id as PublicReportSection['id'])) {
      throw new Error('Public context bundle section does not exist in report.');
    }
    for (const publicSourceId of section.public_source_ids) {
      if (typeof publicSourceId !== 'string' || !publicSourceIds.has(publicSourceId)) {
        throw new Error('Public context bundle source does not exist in report.');
      }
    }
  }
}

export function validatePublicReportManifest(
  value: unknown,
  projectSlug: string,
  reportId: string,
): asserts value is PublicReportManifestV1 {
  if (!isRecord(value)) {
    throw new Error('Public report manifest must be an object.');
  }
  if (value.schema_version !== 'public-report-manifest-v1') {
    throw new Error('Public report manifest schema_version is invalid.');
  }
  if (value.project_slug !== projectSlug || value.report_id !== reportId) {
    throw new Error('Public report manifest target mismatch.');
  }
  if (
    typeof value.artifact_version !== 'string' ||
    typeof value.published_at !== 'string' ||
    typeof value.etag !== 'string'
  ) {
    throw new Error('Public report manifest metadata is invalid.');
  }
  if (value.revoked_at !== null && typeof value.revoked_at !== 'string') {
    throw new Error('Public report manifest revoked_at is invalid.');
  }
  if (value.revoked_at !== null) {
    return;
  }
  const allowedPrefix = `${projectSlug}/reports/public/${reportId}/${value.artifact_version}/`;
  for (const key of ['public_report_uri', 'public_context_bundle_uri']) {
    const uri = value[key];
    if (typeof uri !== 'string' || !storageUriHasAllowedPublicPrefix(uri, allowedPrefix)) {
      throw new Error(`Public report manifest ${key} is outside the allowed prefix.`);
    }
  }
}

function validatePublicProjectManifest(
  value: unknown,
  projectSlug: string,
): asserts value is PublicProjectManifestV1 {
  if (!isRecord(value)) {
    throw new Error('Public project manifest must be an object.');
  }
  if (value.schema_version !== 'public-project-manifest-v1') {
    throw new Error('Public project manifest schema_version is invalid.');
  }
  if (value.project_slug !== projectSlug) {
    throw new Error('Public project manifest target mismatch.');
  }
  if (value.visibility !== 'private' && value.visibility !== 'public') {
    throw new Error('Public project manifest visibility is invalid.');
  }
  if (value.published_at !== null && typeof value.published_at !== 'string') {
    throw new Error('Public project manifest published_at is invalid.');
  }
}

async function readPublicProjectManifest(input: {
  readonly projectSlug: string;
  readonly storage: ObjectStorage;
}): Promise<PublicProjectManifestV1 | undefined> {
  if (!PROJECT_SLUG_PATTERN.test(input.projectSlug)) {
    return undefined;
  }
  const path = publicProjectManifestPath(input.projectSlug);
  if (!(await input.storage.exists(path))) {
    return undefined;
  }
  const manifest = JSON.parse(await input.storage.getText(path)) as unknown;
  validatePublicProjectManifest(manifest, input.projectSlug);
  return manifest;
}

function publicProjectManifestPath(projectSlug: string): string {
  return `${projectSlug}/project-public-state.json`;
}

function redactItems(items: readonly Record<string, unknown>[] | undefined) {
  return items?.map((item) => redactRecord(item));
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_PUBLIC_REPORT_KEYS.has(key))
      .map(([key, fieldValue]) => [key, redactUnknown(fieldValue)]),
  );
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (isRecord(value)) {
    return redactRecord(value);
  }
  return value;
}

function redactText(value: string): string {
  const emailRedacted = replaceEmails(value, '[redacted-email]');
  return replacePrivateTokens(emailRedacted);
}

function containsPrivateText(value: string): boolean {
  return hasEmail(value) || privateTokenRanges(value).length > 0;
}

function hasEmail(value: string): boolean {
  return emailRanges(value).length > 0;
}

function replaceEmails(value: string, replacement: string): string {
  const ranges = emailRanges(value);
  if (ranges.length === 0) {
    return value;
  }

  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += value.slice(cursor, range.start);
    output += replacement;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

function emailRanges(value: string): { end: number; start: number }[] {
  const ranges: { end: number; start: number }[] = [];
  let index = 0;
  while (index < value.length) {
    const atIndex = value.indexOf('@', index);
    if (atIndex === -1) {
      break;
    }

    const start = emailLocalStart(value, atIndex);
    const end = emailDomainEnd(value, atIndex);
    if (start < atIndex && end > atIndex + 1 && hasEmailTopLevelDomain(value, atIndex + 1, end)) {
      ranges.push({ end, start });
      index = end;
    } else {
      index = atIndex + 1;
    }
  }
  return ranges;
}

function emailLocalStart(value: string, atIndex: number): number {
  let cursor = atIndex - 1;
  while (cursor >= 0 && isEmailLocalChar(value.charCodeAt(cursor))) {
    cursor -= 1;
  }
  return cursor + 1;
}

function emailDomainEnd(value: string, atIndex: number): number {
  let cursor = atIndex + 1;
  while (cursor < value.length && isEmailDomainChar(value.charCodeAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

function hasEmailTopLevelDomain(value: string, domainStart: number, domainEnd: number): boolean {
  const lastDot = value.lastIndexOf('.', domainEnd - 1);
  if (lastDot < domainStart || domainEnd - lastDot - 1 < 2) {
    return false;
  }

  for (let index = lastDot + 1; index < domainEnd; index += 1) {
    if (!isAsciiAlpha(value.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

function isEmailLocalChar(code: number): boolean {
  return (
    isAsciiAlphaNumeric(code) ||
    code === 37 ||
    code === 43 ||
    code === 45 ||
    code === 46 ||
    code === 95
  );
}

function isEmailDomainChar(code: number): boolean {
  return isAsciiAlphaNumeric(code) || code === 45 || code === 46;
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiAlpha(code) || (code >= 48 && code <= 57);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function replacePrivateTokens(value: string): string {
  const ranges = privateTokenRanges(value);
  if (ranges.length === 0) {
    return value;
  }
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += value.slice(cursor, range.start);
    output += range.replacement;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

function privateTokenRanges(value: string): { end: number; replacement: string; start: number }[] {
  const ranges: { end: number; replacement: string; start: number }[] = [];
  const lowerValue = value.toLowerCase();
  let index = 0;
  while (index < value.length) {
    const uriStart = nextUriStart(lowerValue, index);
    if (!uriStart) {
      break;
    }
    const end = tokenEnd(value, uriStart.index);
    const token = value.slice(uriStart.index, end);
    if (uriStart.scheme === 'file' || uriStart.scheme === 'gs') {
      ranges.push({ end, replacement: '[redacted-uri]', start: uriStart.index });
    } else if (isPrivateHttpUrl(token)) {
      ranges.push({ end, replacement: '[redacted-url]', start: uriStart.index });
    }
    index = Math.max(end, uriStart.index + uriStart.scheme.length + 3);
  }
  return ranges;
}

function nextUriStart(
  lowerValue: string,
  fromIndex: number,
): { index: number; scheme: string } | undefined {
  const schemes = ['https', 'http', 'file', 'gs'];
  let found: { index: number; scheme: string } | undefined;
  for (const scheme of schemes) {
    const index = lowerValue.indexOf(`${scheme}://`, fromIndex);
    if (index >= 0 && (!found || index < found.index)) {
      found = { index, scheme };
    }
  }
  return found;
}

function tokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length && !isUriTerminator(value.charAt(index))) {
    index += 1;
  }
  return index;
}

function isUriTerminator(char: string): boolean {
  return char.trim() === '' || char === ')' || char === '"' || char === "'" || char === '<';
}

function isPrivateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      isPrivate10Host(hostname) ||
      isPrivate172Host(hostname) ||
      isPrivate192Host(hostname) ||
      hostname.includes('internal') ||
      hostname.includes('corp') ||
      hostname.includes('intranet') ||
      hostname.split('.').includes('local')
    );
  } catch {
    return false;
  }
}

function isPrivate10Host(hostname: string): boolean {
  if (!hostname.startsWith('10.')) {
    return false;
  }
  return isIpv4Host(hostname);
}

function isPrivate172Host(hostname: string): boolean {
  if (!hostname.startsWith('172.')) {
    return false;
  }
  if (!isIpv4Host(hostname)) {
    return false;
  }
  const secondOctet = Number(hostname.split('.')[1]);
  return Number.isInteger(secondOctet) && secondOctet >= 16 && secondOctet <= 31;
}

function isPrivate192Host(hostname: string): boolean {
  if (!hostname.startsWith('192.168.')) {
    return false;
  }
  return isIpv4Host(hostname);
}

function isIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (part === '' || part.length > 3) {
        return false;
      }
      for (let index = 0; index < part.length; index += 1) {
        const code = part.charCodeAt(index);
        if (code < 48 || code > 57) {
          return false;
        }
      }
      const value = Number(part);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    })
  );
}

function publicSourceLabel(docType: string, index: number): string {
  return `公開ソース ${index + 1} (${redactText(docType)})`;
}

function storageUriHasAllowedPublicPrefix(uri: string, allowedPrefix: string): boolean {
  if (uri.includes('/../') || uri.endsWith('/..')) {
    return false;
  }
  if (uri.startsWith('file://') || uri.startsWith('/') || uri.includes('://')) {
    return uri.includes(`/${allowedPrefix}`);
  }
  return uri.startsWith(allowedPrefix);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const PUBLIC_REPORT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const PRIVATE_PUBLIC_REPORT_KEYS = new Set([
  'canonical_uri',
  'document_id',
  'parsed_uri',
  'project_id',
  'raw_uri',
  'snippet',
  'storage_uri',
]);
