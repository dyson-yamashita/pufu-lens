import type { ActorMention, ParsedDocument, ParsedDocumentType } from './ingestion-fixtures.js';
import { validateParsedDocument } from './ingestion-fixtures.js';

export type GraphActorAliasType = 'email' | 'github_login';
export type GraphEdgeType =
  | 'AUTHORED'
  | 'COMMENTED_ON'
  | 'MENTIONS'
  | 'OWNS'
  | 'REPLY_TO'
  | 'REVIEWED'
  | 'SAME_AS'
  | 'SENT';

export interface GraphRelationProjectRecord {
  graphName: string;
  id: string;
  slug: string;
}

export interface GraphRelationDocumentRecord {
  docType: ParsedDocumentType;
  graphNodeId: string;
  id: string;
  rawDocumentId: string;
}

export interface GraphRelationActorRecord {
  displayName: string;
  graphNodeId: string;
  id: string;
}

export interface GraphRelationTarget {
  document: GraphRelationDocumentRecord;
  parsed: ParsedDocument | string;
  rawContentHash: string;
  rawDocumentId: string;
}

export interface GraphNodeInput {
  graphNodeId: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdgeInput {
  fromGraphNodeId: string;
  properties: Record<string, unknown>;
  toGraphNodeId: string;
  type: GraphEdgeType;
}

export interface ReplaceEmailQuotesInput {
  documentId: string;
  projectId: string;
  quotes: GraphEmailQuoteInput[];
}

export interface GraphEmailQuoteInput {
  bodyText: string;
  prevQuoteIndex?: number;
  quoteIndex: number;
  quotedMessageId: string;
  senderActorId?: string;
  senderAlias: string;
  sentAt: string;
}

export interface GraphRelationsRepository {
  findActorByAlias(input: {
    aliasType: GraphActorAliasType;
    aliasValue: string;
    projectId: string;
  }): Promise<GraphRelationActorRecord | undefined>;
  findActorByGraphNodeId(input: {
    graphNodeId: string;
    projectId: string;
  }): Promise<GraphRelationActorRecord | undefined>;
  findSameAsDocuments(input: {
    projectId: string;
    rawContentHash: string;
    rawDocumentId: string;
    sourceType: ParsedDocument['sourceType'];
  }): Promise<GraphRelationDocumentRecord[]>;
  lookupProjectBySlug(slug: string): Promise<GraphRelationProjectRecord | undefined>;
  markFailed(input: {
    errorMessage: string;
    projectId: string;
    rawDocumentId: string;
  }): Promise<void>;
  markIndexed(input: { projectId: string; rawDocumentId: string }): Promise<void>;
  readGraphTargets(input: { limit: number; projectId: string }): Promise<GraphRelationTarget[]>;
  replaceEmailQuotes(input: ReplaceEmailQuotesInput): Promise<void>;
  upsertGraphEdge(input: GraphEdgeInput): Promise<void>;
  upsertGraphNode(input: GraphNodeInput): Promise<void>;
}

export interface StoreGraphRelationsOptions {
  limit: number;
  projectSlug: string;
  repository: GraphRelationsRepository;
}

export interface StoreGraphRelationsResult {
  decisions: StoreGraphRelationDecision[];
  projectSlug: string;
}

export interface StoreGraphRelationDecision {
  actorEdgeCount: number;
  decision: 'failed' | 'indexed';
  documentId: string;
  emailQuoteCount: number;
  errorMessage?: string;
  graphEdgeCount: number;
  graphNodeCount: number;
  rawDocumentId: string;
  sameAsCount: number;
  sourceId: string;
}

interface GraphRelationContext {
  project: GraphRelationProjectRecord;
  repository: GraphRelationsRepository;
}

export async function storeGraphRelations(
  options: StoreGraphRelationsOptions,
): Promise<StoreGraphRelationsResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }
  validateGraphName(project.graphName);

  const targets = await options.repository.readGraphTargets({
    limit: options.limit,
    projectId: project.id,
  });
  const context = { project, repository: options.repository };
  const decisions: StoreGraphRelationDecision[] = [];

  for (const target of targets) {
    decisions.push(await storeGraphTargetSafely(context, target));
  }

  return { decisions, projectSlug: project.slug };
}

async function storeGraphTargetSafely(
  context: GraphRelationContext,
  target: GraphRelationTarget,
): Promise<StoreGraphRelationDecision> {
  try {
    return await storeGraphTarget(context, target);
  } catch (error) {
    const errorMessage = safeErrorMessage(error);
    await context.repository.markFailed({
      errorMessage,
      projectId: context.project.id,
      rawDocumentId: target.rawDocumentId,
    });
    return {
      actorEdgeCount: 0,
      decision: 'failed',
      documentId: target.document.id,
      emailQuoteCount: 0,
      errorMessage,
      graphEdgeCount: 0,
      graphNodeCount: 0,
      rawDocumentId: target.rawDocumentId,
      sameAsCount: 0,
      sourceId: sourceIdForFailure(target),
    };
  }
}

async function storeGraphTarget(
  context: GraphRelationContext,
  target: GraphRelationTarget,
): Promise<StoreGraphRelationDecision> {
  const parsed = parseTargetDocument(target.parsed);
  validateDocumentGraphKey(target.document, parsed);

  let graphNodeCount = 0;
  let graphEdgeCount = 0;
  let actorEdgeCount = 0;
  let sameAsCount = 0;

  await context.repository.upsertGraphNode(documentGraphNode(context.project, target, parsed));
  graphNodeCount += 1;

  for (const actorEdge of await actorEdges(context, parsed, target.document.graphNodeId)) {
    await context.repository.upsertGraphNode(actorEdge.node);
    await context.repository.upsertGraphEdge(actorEdge.edge);
    graphNodeCount += 1;
    graphEdgeCount += 1;
    actorEdgeCount += 1;
  }

  for (const relationNodeEdge of relationNodesAndEdges(context.project, parsed, target)) {
    await context.repository.upsertGraphNode(relationNodeEdge.node);
    await context.repository.upsertGraphEdge(relationNodeEdge.edge);
    graphNodeCount += 1;
    graphEdgeCount += 1;
  }

  const emailQuotes = await resolvedEmailQuotes(context, parsed);
  await context.repository.replaceEmailQuotes({
    documentId: target.document.id,
    projectId: context.project.id,
    quotes: emailQuotes,
  });

  for (const sameAsDocument of await context.repository.findSameAsDocuments({
    projectId: context.project.id,
    rawContentHash: target.rawContentHash,
    rawDocumentId: target.rawDocumentId,
    sourceType: parsed.sourceType,
  })) {
    await context.repository.upsertGraphEdge({
      fromGraphNodeId: target.document.graphNodeId,
      properties: {
        confidence: 1,
        projectId: context.project.id,
        reason: 'content_hash_match',
      },
      toGraphNodeId: sameAsDocument.graphNodeId,
      type: 'SAME_AS',
    });
    graphEdgeCount += 1;
    sameAsCount += 1;
  }

  await context.repository.markIndexed({
    projectId: context.project.id,
    rawDocumentId: target.rawDocumentId,
  });

  return {
    actorEdgeCount,
    decision: 'indexed',
    documentId: target.document.id,
    emailQuoteCount: emailQuotes.length,
    graphEdgeCount,
    graphNodeCount,
    rawDocumentId: target.rawDocumentId,
    sameAsCount,
    sourceId: parsed.sourceId,
  };
}

function documentGraphNode(
  project: GraphRelationProjectRecord,
  target: GraphRelationTarget,
  parsed: ParsedDocument,
): GraphNodeInput {
  return {
    graphNodeId: target.document.graphNodeId,
    labels: ['Document', documentLabel(parsed.docType)],
    properties: {
      canonicalUri: parsed.canonicalUri,
      docType: parsed.docType,
      documentId: target.document.id,
      occurredAt: parsed.occurredAt,
      projectId: project.id,
      rawDocumentId: target.rawDocumentId,
      sourceId: parsed.sourceId,
      sourceType: parsed.sourceType,
      title: parsed.title,
    },
  };
}

async function actorEdges(
  context: GraphRelationContext,
  parsed: ParsedDocument,
  documentGraphNodeId: string,
): Promise<Array<{ edge: GraphEdgeInput; node: GraphNodeInput }>> {
  const result: Array<{ edge: GraphEdgeInput; node: GraphNodeInput }> = [];
  for (const [index, mention] of parsed.actors.entries()) {
    const actor = await findResolvedActor(context, parsed, mention, `${mention.role}:${index}`);
    if (!actor) {
      continue;
    }
    result.push({
      edge: {
        fromGraphNodeId: actor.graphNodeId,
        properties: {
          actorId: actor.id,
          role: mention.role,
        },
        toGraphNodeId: documentGraphNodeId,
        type: actorEdgeType(mention.role),
      },
      node: {
        graphNodeId: actor.graphNodeId,
        labels: ['Actor'],
        properties: {
          actorId: actor.id,
          displayName: actor.displayName,
          projectId: context.project.id,
        },
      },
    });
  }
  return result;
}

function relationNodesAndEdges(
  project: GraphRelationProjectRecord,
  parsed: ParsedDocument,
  target: GraphRelationTarget,
): Array<{ edge: GraphEdgeInput; node: GraphNodeInput }> {
  return parsed.relations
    .filter((relation) => relation.type === 'LINKS_TO' || relation.type === 'REPLY_TO')
    .map((relation) => {
      const topicGraphNodeId =
        relation.type === 'REPLY_TO'
          ? `topic:message:${encodeURIComponent(relation.target)}`
          : `topic:uri:${encodeURIComponent(relation.target)}`;
      return {
        edge: {
          fromGraphNodeId: target.document.graphNodeId,
          properties: {
            ...relation.metadata,
            projectId: project.id,
            relationTarget: relation.target,
            relationType: relation.type,
          },
          toGraphNodeId: topicGraphNodeId,
          type: relation.type === 'REPLY_TO' ? 'REPLY_TO' : 'MENTIONS',
        },
        node: {
          graphNodeId: topicGraphNodeId,
          labels: ['Topic'],
          properties: {
            projectId: project.id,
            target: relation.target,
            topicType: relation.type === 'REPLY_TO' ? 'message' : 'uri',
          },
        },
      };
    });
}

async function resolvedEmailQuotes(
  context: GraphRelationContext,
  parsed: ParsedDocument,
): Promise<GraphEmailQuoteInput[]> {
  const quotes = parsed.emailQuotes ?? [];
  const messageToIndex = new Map<string, number>();
  const result: GraphEmailQuoteInput[] = [];

  for (const [index, quote] of quotes.entries()) {
    const quoteIndex = index + 1;
    const sender = parseSenderAlias(quote.from);
    const senderActor = await findResolvedActor(
      context,
      parsed,
      { displayName: sender.displayName, email: sender.email, role: 'sender' },
      `quote:${index}`,
    );
    const prevQuoteIndex =
      quote.prevMessageId === undefined ? undefined : messageToIndex.get(quote.prevMessageId);
    messageToIndex.set(quote.messageId, quoteIndex);
    result.push({
      bodyText: quote.bodyText,
      prevQuoteIndex,
      quoteIndex,
      quotedMessageId: quote.messageId,
      senderActorId: senderActor?.id,
      senderAlias: quote.from,
      sentAt: quote.sentAt,
    });
  }

  return result;
}

async function findResolvedActor(
  context: GraphRelationContext,
  parsed: ParsedDocument,
  mention: ActorMention,
  occurrenceKey: string,
): Promise<GraphRelationActorRecord | undefined> {
  for (const alias of strongAliases(mention)) {
    const actor = await context.repository.findActorByAlias({
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue,
      projectId: context.project.id,
    });
    if (actor) {
      return actor;
    }
  }

  return context.repository.findActorByGraphNodeId({
    graphNodeId: unresolvedActorGraphNodeId({
      displayName: mention.displayName,
      occurrenceKey,
      sourceId: parsed.sourceId,
    }),
    projectId: context.project.id,
  });
}

function strongAliases(
  mention: ActorMention,
): Array<{ aliasType: GraphActorAliasType; aliasValue: string }> {
  const aliases: Array<{ aliasType: GraphActorAliasType; aliasValue: string }> = [];
  const email = mention.email?.trim().toLowerCase();
  const githubLogin = mention.githubLogin?.trim().toLowerCase();
  if (email) {
    aliases.push({ aliasType: 'email', aliasValue: email });
  }
  if (githubLogin) {
    aliases.push({ aliasType: 'github_login', aliasValue: githubLogin });
  }
  return aliases;
}

function parseSenderAlias(value: string): { displayName: string; email?: string } {
  const ltIndex = value.lastIndexOf('<');
  const gtIndex = value.lastIndexOf('>');
  if (ltIndex !== -1 && gtIndex > ltIndex) {
    const email = value
      .slice(ltIndex + 1, gtIndex)
      .trim()
      .toLowerCase();
    const name = value.slice(0, ltIndex).trim();
    if (email.includes('@')) {
      return { displayName: name || email, email };
    }
  }
  return { displayName: value.trim() };
}

function validateDocumentGraphKey(
  document: GraphRelationDocumentRecord,
  parsed: ParsedDocument,
): void {
  const expected = documentGraphNodeId(parsed);
  if (document.graphNodeId !== expected) {
    throw new Error(
      `Document graph key mismatch for ${parsed.sourceId}: expected ${expected}, got ${document.graphNodeId}`,
    );
  }
}

function validateGraphName(graphName: string): void {
  if (!/^graph_[a-z0-9_]+$/.test(graphName) || graphName.length > 63) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
}

function documentGraphNodeId(parsed: ParsedDocument): string {
  return `document:${parsed.docType}:${encodeURIComponent(parsed.sourceId)}`;
}

function unresolvedActorGraphNodeId(input: {
  displayName: string;
  occurrenceKey: string;
  sourceId: string;
}): string {
  return `actor:unresolved:${encodeURIComponent(input.sourceId)}:${encodeURIComponent(
    input.occurrenceKey,
  )}:${encodeURIComponent(input.displayName)}`;
}

function documentLabel(docType: ParsedDocumentType): string {
  switch (docType) {
    case 'drive_doc':
      return 'DriveDoc';
    case 'email':
      return 'Email';
    case 'issue':
      return 'Issue';
    case 'pull_request':
      return 'PullRequest';
    case 'web_page':
      return 'WebPage';
  }
}

function actorEdgeType(role: ActorMention['role']): GraphEdgeType {
  switch (role) {
    case 'author':
      return 'AUTHORED';
    case 'commenter':
      return 'COMMENTED_ON';
    case 'owner':
      return 'OWNS';
    case 'reviewer':
      return 'REVIEWED';
    case 'sender':
      return 'SENT';
  }
}

function parseTargetDocument(value: ParsedDocument | string): ParsedDocument {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as ParsedDocument) : value;
  return validateParsedDocument(parsed);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}

function sourceIdForFailure(target: GraphRelationTarget): string {
  try {
    return parseTargetDocument(target.parsed).sourceId;
  } catch {
    return target.document.graphNodeId;
  }
}
