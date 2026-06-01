import { parseSenderAlias } from './actor-resolution.js';
import type { ActorMention, ParsedDocument, ParsedRelation } from './ingestion-fixtures.js';
import { validateParsedDocument } from './ingestion-fixtures.js';

export type GraphNodeLabel = 'Actor' | 'Document' | 'Topic';

export type GraphEdgeType =
  | 'COMMENTED_ON'
  | 'LINKS_TO'
  | 'MENTIONS'
  | 'REPLY_TO'
  | 'REVIEWED'
  | 'SAME_AS';

export interface GraphRelationProjectRecord {
  graphName: string;
  id: string;
  slug: string;
}

export interface GraphRelationDocumentTarget {
  canonicalUri?: string;
  docType: ParsedDocument['docType'];
  documentId: string;
  graphNodeId: string;
  occurredAt?: string;
  parsed: ParsedDocument | string;
  rawDocumentId: string;
  title?: string;
}

export interface GraphActorRecord {
  displayName: string;
  graphNodeId: string;
  id: string;
  primaryEmail?: string;
  primaryLogin?: string;
}

export interface GraphEmailQuoteInput {
  body: string;
  documentId: string;
  metadata: Record<string, unknown>;
  prevQuoteIndex?: number;
  projectId: string;
  quoteIndex: number;
  quotedMessageId: string;
  senderActorId?: string;
  senderAlias: string;
  sentAt: string;
}

export interface GraphNodeInput {
  graphName: string;
  key: string;
  label: GraphNodeLabel;
  properties: Record<string, unknown>;
}

export interface GraphEdgeInput {
  fromKey: string;
  graphName: string;
  key: string;
  properties: Record<string, unknown>;
  toKey: string;
  type: GraphEdgeType;
}

export interface GraphRelationRepository {
  findActorByAlias(input: {
    aliasType: 'email' | 'github_login';
    aliasValue: string;
    projectId: string;
  }): Promise<GraphActorRecord | undefined>;
  listDocumentsForGraph(input: {
    limit: number;
    projectId: string;
  }): Promise<GraphRelationDocumentTarget[]>;
  lookupProjectBySlug(slug: string): Promise<GraphRelationProjectRecord | undefined>;
  markIndexed(input: { projectId: string; rawDocumentId: string }): Promise<void>;
  mergeGraphEdge(input: GraphEdgeInput): Promise<void>;
  mergeGraphNode(input: GraphNodeInput): Promise<void>;
  replaceEmailQuotes(input: {
    documentId: string;
    projectId: string;
    quotes: GraphEmailQuoteInput[];
  }): Promise<void>;
}

export interface IndexGraphRelationsOptions {
  limit: number;
  projectSlug: string;
  repository: GraphRelationRepository;
}

export interface IndexGraphRelationsResult {
  decisions: IndexGraphRelationsDecision[];
  projectSlug: string;
}

export interface IndexGraphRelationsDecision {
  actorEdges: number;
  documentId: string;
  emailQuotes: number;
  graphEdges: number;
  graphNodes: number;
  rawDocumentId: string;
  relationEdges: number;
  sourceId: string;
}

interface GraphBuildContext {
  actorCache: Map<string, GraphActorRecord | undefined>;
  graphName: string;
  projectId: string;
  repository: GraphRelationRepository;
}

export async function indexGraphRelations(
  options: IndexGraphRelationsOptions,
): Promise<IndexGraphRelationsResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const targets = await options.repository.listDocumentsForGraph({
    limit: options.limit,
    projectId: project.id,
  });
  const context: GraphBuildContext = {
    actorCache: new Map(),
    graphName: project.graphName,
    projectId: project.id,
    repository: options.repository,
  };
  const decisions: IndexGraphRelationsDecision[] = [];

  for (const target of targets) {
    decisions.push(await indexDocumentGraph(context, target));
  }

  return { decisions, projectSlug: project.slug };
}

async function indexDocumentGraph(
  context: GraphBuildContext,
  target: GraphRelationDocumentTarget,
): Promise<IndexGraphRelationsDecision> {
  const parsed = parseTargetDocument(target.parsed);
  if (target.graphNodeId !== documentGraphNodeId(parsed)) {
    throw new Error(
      `Document graph_node_id mismatch for ${target.documentId}: expected ${documentGraphNodeId(
        parsed,
      )}, got ${target.graphNodeId}`,
    );
  }

  let graphNodes = 0;
  let graphEdges = 0;
  let actorEdges = 0;
  let relationEdges = 0;

  await context.repository.mergeGraphNode({
    graphName: context.graphName,
    key: target.graphNodeId,
    label: 'Document',
    properties: {
      canonicalUri: target.canonicalUri ?? parsed.canonicalUri,
      documentId: target.documentId,
      docType: target.docType,
      occurredAt: target.occurredAt ?? parsed.occurredAt,
      rawDocumentId: target.rawDocumentId,
      sourceId: parsed.sourceId,
      sourceType: parsed.sourceType,
      title: target.title ?? parsed.title,
    },
  });
  graphNodes += 1;

  for (const [index, mention] of parsed.actors.entries()) {
    const actor = await findActorForMention(context, mention);
    if (!actor) {
      continue;
    }
    await context.repository.mergeGraphNode({
      graphName: context.graphName,
      key: actor.graphNodeId,
      label: 'Actor',
      properties: {
        actorId: actor.id,
        displayName: actor.displayName,
        primaryEmail: actor.primaryEmail,
        primaryLogin: actor.primaryLogin,
      },
    });
    graphNodes += 1;
    await context.repository.mergeGraphEdge({
      fromKey: actor.graphNodeId,
      graphName: context.graphName,
      key: graphEdgeKey('MENTIONS', actor.graphNodeId, target.graphNodeId, mention.role, index),
      properties: {
        actorId: actor.id,
        documentId: target.documentId,
        role: mention.role,
      },
      toKey: target.graphNodeId,
      type: 'MENTIONS',
    });
    graphEdges += 1;
    actorEdges += 1;
  }

  for (const [index, relation] of parsed.relations.entries()) {
    const edge = graphEdgeForParsedRelation(target.graphNodeId, relation, index);
    await context.repository.mergeGraphNode({
      graphName: context.graphName,
      key: edge.topicKey,
      label: 'Topic',
      properties: {
        relationType: relation.type,
        target: relation.target,
      },
    });
    graphNodes += 1;
    await context.repository.mergeGraphEdge({
      fromKey: target.graphNodeId,
      graphName: context.graphName,
      key: edge.key,
      properties: {
        ...relation.metadata,
        target: relation.target,
      },
      toKey: edge.topicKey,
      type: edge.type,
    });
    graphEdges += 1;
    relationEdges += 1;
  }

  const emailQuotes = await buildEmailQuotes(context, target, parsed);
  await context.repository.replaceEmailQuotes({
    documentId: target.documentId,
    projectId: context.projectId,
    quotes: emailQuotes,
  });
  await context.repository.markIndexed({
    projectId: context.projectId,
    rawDocumentId: target.rawDocumentId,
  });

  return {
    actorEdges,
    documentId: target.documentId,
    emailQuotes: emailQuotes.length,
    graphEdges,
    graphNodes,
    rawDocumentId: target.rawDocumentId,
    relationEdges,
    sourceId: parsed.sourceId,
  };
}

async function buildEmailQuotes(
  context: GraphBuildContext,
  target: GraphRelationDocumentTarget,
  parsed: ParsedDocument,
): Promise<GraphEmailQuoteInput[]> {
  const quotes: GraphEmailQuoteInput[] = [];
  const messageToIndex = new Map<string, number>();

  for (const [index, quote] of (parsed.emailQuotes ?? []).entries()) {
    const quoteIndex = index + 1;
    const sender = parseSenderAlias(quote.from);
    const senderActor = await findActorForMention(context, {
      email: sender.email,
    });
    const prevQuoteIndex =
      quote.prevMessageId === undefined ? undefined : messageToIndex.get(quote.prevMessageId);

    messageToIndex.set(quote.messageId, quoteIndex);
    quotes.push({
      body: quote.bodyText,
      documentId: target.documentId,
      metadata: { sourceId: parsed.sourceId },
      prevQuoteIndex,
      projectId: context.projectId,
      quoteIndex,
      quotedMessageId: quote.messageId,
      senderActorId: senderActor?.id,
      senderAlias: quote.from,
      sentAt: quote.sentAt,
    });
  }

  return quotes;
}

async function findActorForMention(
  context: GraphBuildContext,
  mention: Pick<ActorMention, 'email' | 'githubLogin'>,
): Promise<GraphActorRecord | undefined> {
  const email = normalizeAliasValue(mention.email);
  if (email) {
    return findActorByAliasCached(context, 'email', email);
  }

  const githubLogin = normalizeAliasValue(mention.githubLogin);
  if (githubLogin) {
    return findActorByAliasCached(context, 'github_login', githubLogin);
  }

  return undefined;
}

async function findActorByAliasCached(
  context: GraphBuildContext,
  aliasType: 'email' | 'github_login',
  aliasValue: string,
): Promise<GraphActorRecord | undefined> {
  const cacheKey = `${aliasType}:${aliasValue}`;
  if (context.actorCache.has(cacheKey)) {
    return context.actorCache.get(cacheKey);
  }
  const actor = await context.repository.findActorByAlias({
    aliasType,
    aliasValue,
    projectId: context.projectId,
  });
  context.actorCache.set(cacheKey, actor);
  return actor;
}

function graphEdgeForParsedRelation(
  documentGraphNodeId: string,
  relation: ParsedRelation,
  index: number,
): { key: string; topicKey: string; type: GraphEdgeType } {
  const type = relation.type === 'SAME_AS_CANDIDATE' ? 'SAME_AS' : relation.type;
  const topicKey = `topic:${type.toLowerCase()}:${encodeURIComponent(relation.target)}`;
  return {
    key: graphEdgeKey(type, documentGraphNodeId, topicKey, relation.target, index),
    topicKey,
    type,
  };
}

function graphEdgeKey(
  type: GraphEdgeType,
  fromKey: string,
  toKey: string,
  discriminator: string,
  index: number,
): string {
  return `edge:${type}:${encodeURIComponent(fromKey)}:${encodeURIComponent(
    toKey,
  )}:${encodeURIComponent(discriminator)}:${index}`;
}

function documentGraphNodeId(parsed: ParsedDocument): string {
  return `document:${parsed.docType}:${encodeURIComponent(parsed.sourceId)}`;
}

function parseTargetDocument(value: ParsedDocument | string): ParsedDocument {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as ParsedDocument) : value;
  return validateParsedDocument(parsed);
}

function normalizeAliasValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === '' ? undefined : normalized;
}
