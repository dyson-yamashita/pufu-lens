import type postgres from 'postgres';
import {
  createPostgresFederatedReportRepository,
  type FederatedReportRepository,
  type MappedInboundReportInput,
} from './federated-report-repository.ts';
import { normalizeRemoteActorUri } from './follow-model.ts';
import { assertInboundReportUrlAllowed } from './inbound-report-sanitizer.ts';
import {
  ACTIVITYSTREAMS_PUBLIC_URI,
  createRemoteArticleResolver,
  parseEmbeddedCreateArticle,
  type RemoteArticleReadModel,
  type RemoteArticleResolver,
} from './remote-article.ts';
import type { BlockedDomainPredicate } from './remote-document.ts';

/** Result of processing a verified inbound Create/Announce activity. */
export type InboundReportProcessResult =
  | { readonly kind: 'saved' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'rejected'; readonly code: InboundReportRejectionCode };

export type InboundReportRejectionCode =
  | 'invalid_activity'
  | 'invalid_object'
  | 'unsupported_type'
  | 'actor_mismatch'
  | 'no_matching_follow';

/** ActivityPub inbound report use cases for federation listeners. */
export type ActivityPubInboundReportUseCases = {
  processVerifiedInboundCreate(input: {
    activityUri: string;
    sourceActorUri: string;
    recipientPreferredUsername: string | null;
    embeddedObject: Record<string, unknown>;
  }): Promise<InboundReportProcessResult>;
  processVerifiedInboundAnnounce(input: {
    activityUri: string;
    sourceActorUri: string;
    recipientPreferredUsername: string | null;
    objectUri: string;
  }): Promise<InboundReportProcessResult>;
};

/** Dependencies for inbound report use cases. */
export type CreateActivityPubInboundReportUseCasesInput = {
  readonly federatedReportRepository: FederatedReportRepository;
  readonly remoteArticleResolver: RemoteArticleResolver;
  readonly isDomainBlocked: BlockedDomainPredicate;
};

/** SQL-backed factory input for inbound report use cases. */
export type CreateActivityPubInboundReportUseCasesWithSqlInput = {
  readonly canonicalOrigin: string;
  readonly sql: postgres.Sql;
  readonly isDomainBlocked: BlockedDomainPredicate;
  readonly fetch?: typeof fetch;
  readonly remoteArticleResolver?: RemoteArticleResolver;
};

/** Creates ActivityPub inbound report use cases from a SQL pool. */
export function createActivityPubInboundReportUseCasesWithSql(
  input: CreateActivityPubInboundReportUseCasesWithSqlInput,
): ActivityPubInboundReportUseCases {
  const federatedReportRepository = createPostgresFederatedReportRepository({ sql: input.sql });
  const remoteArticleResolver =
    input.remoteArticleResolver ??
    createRemoteArticleResolver({
      canonicalOrigin: input.canonicalOrigin,
      fetch: input.fetch ?? fetch,
      isDomainBlocked: input.isDomainBlocked,
    });
  return createActivityPubInboundReportUseCases({
    federatedReportRepository,
    remoteArticleResolver,
    isDomainBlocked: input.isDomainBlocked,
  });
}

/** Creates ActivityPub inbound report use cases. */
export function createActivityPubInboundReportUseCases(
  input: CreateActivityPubInboundReportUseCasesInput,
): ActivityPubInboundReportUseCases {
  return {
    processVerifiedInboundCreate: (params) => processVerifiedInboundCreate({ ...input, ...params }),
    processVerifiedInboundAnnounce: (params) =>
      processVerifiedInboundAnnounce({ ...input, ...params }),
  };
}

function hasPublicAddressing(to: unknown): boolean {
  const values = Array.isArray(to) ? to : to ? [to] : [];
  return values.some((entry) => {
    if (typeof entry === 'string') {
      return entry === ACTIVITYSTREAMS_PUBLIC_URI;
    }
    return false;
  });
}

function readActivityHttpsUrl(
  value: string,
  label: string,
  isDomainBlocked: BlockedDomainPredicate,
): string {
  return assertInboundReportUrlAllowed(normalizeRemoteActorUri(value), label, isDomainBlocked);
}

function toMappedInput(input: {
  activityUri: string;
  activityType: 'Create' | 'Announce';
  sourceActorUri: string;
  article: RemoteArticleReadModel;
}): MappedInboundReportInput {
  return {
    activityUri: input.activityUri,
    activityType: input.activityType,
    sourceActorUri: input.sourceActorUri,
    canonicalRemoteObjectUri: input.article.articleId,
    objectType: 'article',
    title: input.article.title,
    summaryHtmlSanitized: input.article.summaryHtml,
    originalUrl: input.article.originalUrl,
    publishedAt: input.article.publishedAt,
    remoteUpdatedAt: input.article.updatedAt,
  };
}

async function persistMappedReport(input: {
  federatedReportRepository: FederatedReportRepository;
  activityUri: string;
  activityType: 'Create' | 'Announce';
  sourceActorUri: string;
  recipientPreferredUsername: string | null;
  mapped: MappedInboundReportInput;
}): Promise<InboundReportProcessResult> {
  const result = await input.federatedReportRepository.saveInboundReport({
    activityUri: input.activityUri,
    activityType: input.activityType,
    objectType: 'article',
    sourceActorUri: input.sourceActorUri,
    mapped: input.mapped,
    recipientPreferredUsername: input.recipientPreferredUsername,
  });
  return result.saved ? { kind: 'saved' } : { kind: 'ignored' };
}

async function processVerifiedInboundCreate(input: {
  federatedReportRepository: FederatedReportRepository;
  remoteArticleResolver: RemoteArticleResolver;
  isDomainBlocked: BlockedDomainPredicate;
  activityUri: string;
  sourceActorUri: string;
  recipientPreferredUsername: string | null;
  embeddedObject: Record<string, unknown>;
}): Promise<InboundReportProcessResult> {
  try {
    const activityUri = readActivityHttpsUrl(input.activityUri, 'Create id', input.isDomainBlocked);
    const sourceActorUri = readActivityHttpsUrl(
      input.sourceActorUri,
      'Create actor',
      input.isDomainBlocked,
    );
    const objectType = input.embeddedObject.type;
    if (objectType !== 'Article') {
      return { kind: 'rejected', code: 'unsupported_type' };
    }
    if (!hasPublicAddressing(input.embeddedObject.to)) {
      return { kind: 'rejected', code: 'invalid_activity' };
    }
    const article = await parseEmbeddedCreateArticle({
      object: input.embeddedObject,
      createActorUri: sourceActorUri,
      isDomainBlocked: input.isDomainBlocked,
    });
    const mapped = toMappedInput({
      activityUri,
      activityType: 'Create',
      sourceActorUri,
      article,
    });
    return persistMappedReport({
      federatedReportRepository: input.federatedReportRepository,
      activityUri,
      activityType: 'Create',
      sourceActorUri,
      recipientPreferredUsername: input.recipientPreferredUsername,
      mapped,
    });
  } catch {
    return { kind: 'rejected', code: 'invalid_object' };
  }
}

async function processVerifiedInboundAnnounce(input: {
  federatedReportRepository: FederatedReportRepository;
  remoteArticleResolver: RemoteArticleResolver;
  isDomainBlocked: BlockedDomainPredicate;
  activityUri: string;
  sourceActorUri: string;
  recipientPreferredUsername: string | null;
  objectUri: string;
}): Promise<InboundReportProcessResult> {
  try {
    const activityUri = readActivityHttpsUrl(
      input.activityUri,
      'Announce id',
      input.isDomainBlocked,
    );
    const sourceActorUri = readActivityHttpsUrl(
      input.sourceActorUri,
      'Announce actor',
      input.isDomainBlocked,
    );
    const objectUri = readActivityHttpsUrl(
      input.objectUri,
      'Announce object',
      input.isDomainBlocked,
    );
    const article = await input.remoteArticleResolver.resolve(objectUri);
    const mapped = toMappedInput({
      activityUri,
      activityType: 'Announce',
      sourceActorUri,
      article,
    });
    return persistMappedReport({
      federatedReportRepository: input.federatedReportRepository,
      activityUri,
      activityType: 'Announce',
      sourceActorUri,
      recipientPreferredUsername: input.recipientPreferredUsername,
      mapped,
    });
  } catch {
    return { kind: 'rejected', code: 'invalid_object' };
  }
}
