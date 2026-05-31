import type { ActorMention, ParsedDocument } from './ingestion-fixtures.js';
import { validateParsedDocument } from './ingestion-fixtures.js';

export type ActorAliasType = 'email' | 'github_login' | 'display_name';
export type ActorType = 'person' | 'organization' | 'bot';

export interface ActorRecord {
  displayName: string;
  graphNodeId: string;
  id: string;
  primaryEmail?: string;
  primaryLogin?: string;
  projectId: string;
}

export interface ActorAliasRecord {
  actorId: string;
  aliasType: ActorAliasType;
  aliasValue: string;
  confidence: number;
  projectId: string;
  source: string;
}

export interface CreateActorInput {
  actorType: ActorType;
  displayName: string;
  graphNodeId: string;
  metadata: Record<string, unknown>;
  primaryEmail?: string;
  primaryLogin?: string;
  projectId: string;
}

export interface UpsertActorAliasInput {
  actorId: string;
  aliasType: ActorAliasType;
  aliasValue: string;
  confidence: number;
  projectId: string;
  source: string;
}

export interface ActorResolutionRepository {
  createActor(input: CreateActorInput): Promise<ActorRecord>;
  findActorByAlias(input: {
    aliasType: ActorAliasType;
    aliasValue: string;
    projectId: string;
  }): Promise<ActorRecord | undefined>;
  lookupProjectBySlug(slug: string): Promise<{ id: string; slug: string } | undefined>;
  readParsedDocuments(input: {
    limit: number;
    projectId: string;
  }): Promise<ResolveParsedDocumentTarget[]>;
  upsertActorAlias(input: UpsertActorAliasInput): Promise<ActorAliasRecord>;
}

export interface ResolveParsedDocumentTarget {
  parsed: ParsedDocument | string;
  parsedUri?: string;
  rawDocumentId: string;
}

export interface ResolveActorsOptions {
  limit: number;
  projectSlug: string;
  repository: ActorResolutionRepository;
}

export interface ResolveActorsResult {
  decisions: ResolveActorsDecision[];
  projectSlug: string;
}

export interface ResolveActorsDecision {
  actors: ResolvedActorMention[];
  emailQuotes: ResolvedEmailQuote[];
  parsedUri?: string;
  rawDocumentId: string;
  sourceId: string;
  sourceType: ParsedDocument['sourceType'];
}

export interface ResolvedActorMention {
  actorId: string;
  aliases: ResolvedAlias[];
  displayName: string;
  match: 'strong_alias' | 'created';
  role: ActorMention['role'] | 'quoted_sender';
}

export interface ResolvedAlias {
  aliasType: ActorAliasType;
  aliasValue: string;
  confidence: number;
  persisted: boolean;
  source: string;
}

export interface ResolvedEmailQuote {
  bodyText: string;
  prevMessageId?: string;
  prevQuoteIndex?: number;
  quoteIndex: number;
  quotedMessageId: string;
  senderActorId?: string;
  senderAlias: string;
  sentAt: string;
}

interface ResolveContext {
  aliasCache: Map<string, ActorRecord>;
  createdActors: ActorRecord[];
  projectId: string;
  repository: ActorResolutionRepository;
}

export async function resolveActors(options: ResolveActorsOptions): Promise<ResolveActorsResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const targets = await options.repository.readParsedDocuments({
    limit: options.limit,
    projectId: project.id,
  });
  const context: ResolveContext = {
    aliasCache: new Map(),
    createdActors: [],
    projectId: project.id,
    repository: options.repository,
  };
  const decisions: ResolveActorsDecision[] = [];

  for (const target of targets) {
    decisions.push(await resolveParsedDocumentTarget(context, target));
  }

  return { decisions, projectSlug: project.slug };
}

async function resolveParsedDocumentTarget(
  context: ResolveContext,
  target: ResolveParsedDocumentTarget,
): Promise<ResolveActorsDecision> {
  const parsed = parseTargetDocument(target.parsed);
  const actors: ResolvedActorMention[] = [];

  for (const [index, mention] of parsed.actors.entries()) {
    actors.push(await resolveMention(context, mention, parsed, index));
  }

  const emailQuotes = await resolveEmailQuotes(context, parsed);

  return {
    actors,
    emailQuotes,
    parsedUri: target.parsedUri,
    rawDocumentId: target.rawDocumentId,
    sourceId: parsed.sourceId,
    sourceType: parsed.sourceType,
  };
}

async function resolveMention(
  context: ResolveContext,
  mention: ActorMention,
  parsed: ParsedDocument,
  mentionIndex = 0,
): Promise<ResolvedActorMention> {
  const source = aliasSource(parsed, mention.role);
  const aliases = aliasesForMention(mention, source);
  const strongAliases = aliases.filter((alias) => isStrongAlias(alias.aliasType));
  const actor = await findOrCreateActor(context, {
    aliases: strongAliases,
    displayName: mention.displayName,
    occurrenceKey: `${mention.role}:${mentionIndex}`,
    sourceId: parsed.sourceId,
  });
  const persistedAliases = await persistAliases(context, actor.id, aliases);

  return {
    actorId: actor.id,
    aliases: persistedAliases,
    displayName: mention.displayName,
    match: context.createdActors.includes(actor) ? 'created' : 'strong_alias',
    role: mention.role,
  };
}

async function resolveEmailQuotes(
  context: ResolveContext,
  parsed: ParsedDocument,
): Promise<ResolvedEmailQuote[]> {
  const quotes = parsed.emailQuotes ?? [];
  const messageToIndex = new Map<string, number>();
  const resolvedQuotes: ResolvedEmailQuote[] = [];

  for (const [index, quote] of quotes.entries()) {
    const quoteIndex = index + 1;
    const sender = parseSenderAlias(quote.from);
    const senderMention: ActorMention = {
      displayName: sender.displayName,
      email: sender.email,
      role: 'sender',
    };
    const resolved = await resolveMention(context, senderMention, parsed);
    const prevQuoteIndex =
      quote.prevMessageId === undefined ? undefined : messageToIndex.get(quote.prevMessageId);

    messageToIndex.set(quote.messageId, quoteIndex);
    resolvedQuotes.push({
      bodyText: quote.bodyText,
      prevMessageId: quote.prevMessageId,
      prevQuoteIndex,
      quoteIndex,
      quotedMessageId: quote.messageId,
      senderActorId: resolved.actorId,
      senderAlias: quote.from,
      sentAt: quote.sentAt,
    });
  }

  return resolvedQuotes;
}

async function findOrCreateActor(
  context: ResolveContext,
  input: { aliases: ResolvedAlias[]; displayName: string; occurrenceKey: string; sourceId: string },
): Promise<ActorRecord> {
  for (const alias of input.aliases) {
    const cacheKey = actorAliasCacheKey(alias.aliasType, alias.aliasValue);
    const cached = context.aliasCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const actor = await context.repository.findActorByAlias({
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue,
      projectId: context.projectId,
    });
    if (actor) {
      context.aliasCache.set(cacheKey, actor);
      return actor;
    }
  }

  const primaryEmail = input.aliases.find((alias) => alias.aliasType === 'email')?.aliasValue;
  const primaryLogin = input.aliases.find(
    (alias) => alias.aliasType === 'github_login',
  )?.aliasValue;
  const actor = await context.repository.createActor({
    actorType: 'person',
    displayName: input.displayName,
    graphNodeId: actorGraphNodeId(input),
    metadata: {
      resolution: {
        createdBy: 'resolveActors',
        sourceId: input.sourceId,
      },
    },
    primaryEmail,
    primaryLogin,
    projectId: context.projectId,
  });
  context.createdActors.push(actor);

  for (const alias of input.aliases) {
    context.aliasCache.set(actorAliasCacheKey(alias.aliasType, alias.aliasValue), actor);
  }

  return actor;
}

async function persistAliases(
  context: ResolveContext,
  actorId: string,
  aliases: ResolvedAlias[],
): Promise<ResolvedAlias[]> {
  const resolved: ResolvedAlias[] = [];

  for (const alias of aliases) {
    if (!isStrongAlias(alias.aliasType)) {
      resolved.push({ ...alias, persisted: false });
      continue;
    }

    const persisted = await context.repository.upsertActorAlias({
      actorId,
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue,
      confidence: alias.confidence,
      projectId: context.projectId,
      source: alias.source,
    });
    context.aliasCache.set(actorAliasCacheKey(persisted.aliasType, persisted.aliasValue), {
      displayName: '',
      graphNodeId: '',
      id: actorId,
      projectId: context.projectId,
    });
    resolved.push({ ...alias, persisted: true });
  }

  return resolved;
}

function aliasesForMention(mention: ActorMention, source: string): ResolvedAlias[] {
  const aliases: ResolvedAlias[] = [];
  const email = normalizeEmail(mention.email);
  const githubLogin = normalizeGitHubLogin(mention.githubLogin);
  const displayName = normalizeDisplayName(mention.displayName);

  if (email) {
    aliases.push({
      aliasType: 'email',
      aliasValue: email,
      confidence: 1,
      persisted: false,
      source,
    });
  }
  if (githubLogin) {
    aliases.push({
      aliasType: 'github_login',
      aliasValue: githubLogin,
      confidence: 1,
      persisted: false,
      source,
    });
  }
  if (displayName) {
    aliases.push({
      aliasType: 'display_name',
      aliasValue: displayName,
      confidence: 0.4,
      persisted: false,
      source,
    });
  }

  return aliases;
}

function parseTargetDocument(value: ParsedDocument | string): ParsedDocument {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as ParsedDocument) : value;
  return validateParsedDocument(parsed);
}

export function parseSenderAlias(value: string): { displayName: string; email?: string } {
  const match = value.match(/^\s*(?<name>.*?)\s*<(?<email>[^<>@\s]+@[^<>@\s]+)>\s*$/);
  if (!match?.groups) {
    return { displayName: value.trim() };
  }
  const email = match.groups.email;
  if (!email) {
    return { displayName: value.trim() };
  }

  return {
    displayName: match.groups.name?.trim() || email,
    email: normalizeEmail(email),
  };
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

function normalizeGitHubLogin(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}

function normalizeDisplayName(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized === '' ? undefined : normalized;
}

function aliasSource(parsed: ParsedDocument, role: ActorMention['role']): string {
  return `${parsed.sourceType}:${role}`;
}

function isStrongAlias(aliasType: ActorAliasType): boolean {
  return aliasType === 'email' || aliasType === 'github_login';
}

function actorAliasCacheKey(aliasType: ActorAliasType, aliasValue: string): string {
  return `${aliasType}:${aliasValue}`;
}

function actorGraphNodeId(input: {
  aliases: ResolvedAlias[];
  displayName: string;
  occurrenceKey: string;
  sourceId: string;
}): string {
  const strongAlias = input.aliases.find((alias) => isStrongAlias(alias.aliasType));
  if (strongAlias) {
    return `actor:${strongAlias.aliasType}:${strongAlias.aliasValue}`;
  }

  return `actor:unresolved:${input.sourceId}:${input.occurrenceKey}:${input.displayName}`;
}
