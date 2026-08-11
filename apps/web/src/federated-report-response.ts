import {
  assertInboundReportHttpsUrl,
  assertInboundReportTitle,
  sanitizeInboundReportSummaryHtml,
} from '@pufu-lens/activitypub/inbound-report-sanitizer';
import type { FederatedReportApiItem } from './federated-report-api.ts';

const FEDERATED_REPORTS_TOP_LEVEL_KEYS = ['status', 'blockedCount', 'reports'] as const;
const FEDERATED_REPORT_ITEM_KEYS = [
  'title',
  'sourceActor',
  'domain',
  'publishedAt',
  'summaryHtmlSanitized',
  'originalUrl',
] as const;

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Parses unknown JSON into a safe federated reports API response shape. */
export function parseFederatedReportsApiResponse(
  value: unknown,
):
  | { readonly ok: true; readonly response: FederatedReportsApiResponseParsed }
  | { readonly ok: false } {
  if (!isRecord(value) || !hasExactKeys(value, FEDERATED_REPORTS_TOP_LEVEL_KEYS)) {
    return { ok: false };
  }
  const status = value.status;
  const blockedCount = value.blockedCount;
  if (typeof blockedCount !== 'number' || !Number.isInteger(blockedCount) || blockedCount < 0) {
    return { ok: false };
  }
  if (status === 'blocked') {
    if (!Array.isArray(value.reports) || value.reports.length !== 0) {
      return { ok: false };
    }
    return { ok: true, response: { status: 'blocked', reports: [], blockedCount } };
  }
  if (status !== 'ok' || !Array.isArray(value.reports)) {
    return { ok: false };
  }
  const reports: FederatedReportApiItem[] = [];
  for (const entry of value.reports) {
    const parsed = parseFederatedReportApiItem(entry);
    if (!parsed) {
      return { ok: false };
    }
    reports.push(parsed);
  }
  return { ok: true, response: { status: 'ok', reports, blockedCount } };
}

export type FederatedReportsApiResponseParsed =
  | {
      readonly status: 'ok';
      readonly reports: readonly FederatedReportApiItem[];
      readonly blockedCount: number;
    }
  | {
      readonly status: 'blocked';
      readonly reports: readonly [];
      readonly blockedCount: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function parseIsoTimestamp(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new Error('invalid publishedAt');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('invalid publishedAt');
  }
  return value;
}

function parseFederatedReportApiItem(value: unknown): FederatedReportApiItem | undefined {
  if (!isRecord(value) || !hasExactKeys(value, FEDERATED_REPORT_ITEM_KEYS)) {
    return undefined;
  }
  if (
    typeof value.title !== 'string' ||
    typeof value.sourceActor !== 'string' ||
    typeof value.domain !== 'string' ||
    typeof value.summaryHtmlSanitized !== 'string' ||
    typeof value.originalUrl !== 'string'
  ) {
    return undefined;
  }
  if (value.publishedAt !== null && typeof value.publishedAt !== 'string') {
    return undefined;
  }
  try {
    return toSafeFederatedReportApiItem({
      title: value.title,
      sourceActor: value.sourceActor,
      domain: value.domain,
      publishedAt: parseIsoTimestamp(value.publishedAt),
      summaryHtmlSanitized: value.summaryHtmlSanitized,
      originalUrl: value.originalUrl,
    });
  } catch {
    return undefined;
  }
}

/**
 * Re-validates and re-sanitizes a federated report API item before client rendering.
 *
 * @param item - Candidate API item fields from the server response.
 * @returns Defense-in-depth safe API item.
 */
export function toSafeFederatedReportApiItem(item: {
  title: string;
  sourceActor: string;
  domain: string;
  publishedAt: string | null;
  summaryHtmlSanitized: string;
  originalUrl: string;
}): FederatedReportApiItem {
  const sourceActor = assertInboundReportHttpsUrl(item.sourceActor, 'sourceActor');
  const originalUrl = assertInboundReportHttpsUrl(item.originalUrl, 'originalUrl');
  const title = assertInboundReportTitle(item.title);
  const summaryHtmlSanitized = sanitizeInboundReportSummaryHtml(item.summaryHtmlSanitized);
  const domainHost = new URL(originalUrl).hostname;
  if (item.domain !== domainHost) {
    throw new Error('domain mismatch');
  }
  const publishedAt = parseIsoTimestamp(item.publishedAt);
  return {
    title,
    sourceActor,
    domain: domainHost,
    publishedAt,
    summaryHtmlSanitized,
    originalUrl,
  };
}
