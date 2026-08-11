import {
  assertInboundReportHttpsUrl,
  assertInboundReportTitle,
  createPostgresFederatedReportRepository,
  parseBlockedDomainsFromEnv,
  sanitizeInboundReportSummaryHtml,
} from '@pufu-lens/activitypub';
import type postgres from 'postgres';
import { lookupProjectMemberAccess } from './authz.ts';

export type FederatedReportApiItem = {
  readonly title: string;
  readonly sourceActor: string;
  readonly domain: string;
  readonly publishedAt: string | null;
  readonly summaryHtmlSanitized: string;
  readonly originalUrl: string;
};

export type FederatedReportsApiResponse =
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

function isHostBlocked(hostname: string, isDomainBlocked: (host: string) => boolean): boolean {
  return isDomainBlocked(hostname.toLowerCase());
}

function toDefenseInDepthApiItem(row: {
  title: string;
  remoteActorUri: string;
  originalUrl: string;
  summaryHtmlSanitized: string;
  publishedAt: Date | null;
}): FederatedReportApiItem {
  const sourceActor = assertInboundReportHttpsUrl(row.remoteActorUri, 'sourceActor');
  const originalUrl = assertInboundReportHttpsUrl(row.originalUrl, 'originalUrl');
  const title = assertInboundReportTitle(row.title);
  const summaryHtmlSanitized = sanitizeInboundReportSummaryHtml(row.summaryHtmlSanitized);
  return {
    title,
    sourceActor,
    domain: new URL(originalUrl).hostname,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    summaryHtmlSanitized,
    originalUrl,
  };
}

function isReportBlockedByDomain(
  item: FederatedReportApiItem,
  isDomainBlocked: (host: string) => boolean,
): boolean {
  const hosts = [
    new URL(item.sourceActor).hostname,
    new URL(item.originalUrl).hostname,
    item.domain,
  ];
  return hosts.some((host) => isHostBlocked(host, isDomainBlocked));
}

/**
 * Lists federated inbound reports for a project member with current domain-block filtering.
 *
 * @param input - SQL pool, authenticated user, and project slug.
 * @returns Safe API response without internal identifiers.
 */
export async function listProjectFederatedReports(input: {
  sql: postgres.Sql;
  userId: string;
  projectSlug: string;
  blockedDomainsEnv?: string;
}): Promise<FederatedReportsApiResponse> {
  const access = await lookupProjectMemberAccess(input.sql, {
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!access) {
    throw new FederatedReportsForbiddenError();
  }

  const repository = createPostgresFederatedReportRepository({ sql: input.sql });
  const rows = await repository.listByProject({ projectId: access.id });
  const isDomainBlocked = parseBlockedDomainsFromEnv(input.blockedDomainsEnv);

  const visible: FederatedReportApiItem[] = [];
  let blockedCount = 0;
  for (const row of rows) {
    const item = toDefenseInDepthApiItem(row);
    if (isReportBlockedByDomain(item, isDomainBlocked)) {
      blockedCount += 1;
      continue;
    }
    visible.push(item);
  }

  if (visible.length === 0 && blockedCount > 0) {
    return { status: 'blocked', reports: [], blockedCount };
  }

  return { status: 'ok', reports: visible, blockedCount };
}

/** Thrown when the caller lacks project membership for federated report listing. */
export class FederatedReportsForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'FederatedReportsForbiddenError';
  }
}
