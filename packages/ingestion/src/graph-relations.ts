import { parseSenderAlias } from './actor-resolution.js';
import {
  githubLifecycleGraphProperties,
  isGitHubLifecycleOnlyRefresh,
  readGitHubDocumentLifecycle,
} from './github-lifecycle.js';
import type { ActorMention, ParsedDocument, ParsedDocumentType } from './ingestion-fixtures.js';
import { validateParsedDocument } from './ingestion-fixtures.js';

export type GraphActorAliasType = 'email' | 'github_login' | 'domain';
export type GraphEdgeType =
  | 'AUTHORED'
  | 'COMMENTED_ON'
  | 'MENTIONS'
  | 'OWNS'
  | 'REPLY_TO'
  | 'RELATED_TO'
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
  sourceId: string;
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
  findDocumentsBySourceIds(input: {
    projectId: string;
    sourceIds: readonly string[];
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

type GraphNodeEdge = { edge: GraphEdgeInput; node: GraphNodeInput };

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

  if (isGitHubLifecycleOnlyRefresh(parsed.metadata)) {
    await context.repository.upsertGraphNode(documentGraphNode(context.project, target, parsed));
    await context.repository.markIndexed({
      projectId: context.project.id,
      rawDocumentId: target.rawDocumentId,
    });
    return {
      actorEdgeCount: 0,
      decision: 'indexed',
      documentId: target.document.id,
      emailQuoteCount: 0,
      graphEdgeCount: 0,
      graphNodeCount: 1,
      rawDocumentId: target.rawDocumentId,
      sameAsCount: 0,
      sourceId: parsed.sourceId,
    };
  }

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

  for (const topicNodeEdge of topicNodesAndEdges(context.project, parsed, target)) {
    await context.repository.upsertGraphNode(topicNodeEdge.node);
    await context.repository.upsertGraphEdge(topicNodeEdge.edge);
    graphNodeCount += 1;
    graphEdgeCount += 1;
  }

  for (const documentEdge of await relatedDocumentEdges(context, parsed, target)) {
    await context.repository.upsertGraphNode(documentEdge.node);
    await context.repository.upsertGraphEdge(documentEdge.edge);
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
  const lifecycle = readGitHubDocumentLifecycle(parsed.metadata);
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
      ...(lifecycle ? githubLifecycleGraphProperties(lifecycle) : {}),
    },
  };
}

async function actorEdges(
  context: GraphRelationContext,
  parsed: ParsedDocument,
  documentGraphNodeId: string,
): Promise<GraphNodeEdge[]> {
  const edges: Array<GraphNodeEdge | undefined> = await Promise.all(
    parsed.actors.map(async (mention, index) => {
      const actor = await findResolvedActor(context, parsed, mention, `${mention.role}:${index}`);
      if (!actor) {
        return undefined;
      }
      return {
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
      };
    }),
  );
  return edges.filter(isGraphNodeEdge);
}

function topicNodesAndEdges(
  project: GraphRelationProjectRecord,
  parsed: ParsedDocument,
  target: GraphRelationTarget,
): Array<{ edge: GraphEdgeInput; node: GraphNodeInput }> {
  return [
    ...parsedTopicNodesAndEdges(project, parsed, target),
    ...replyTopicNodesAndEdges(project, parsed, target),
  ];
}

async function relatedDocumentEdges(
  context: GraphRelationContext,
  parsed: ParsedDocument,
  target: GraphRelationTarget,
): Promise<Array<{ edge: GraphEdgeInput; node: GraphNodeInput }>> {
  const edges: Array<{ edge: GraphEdgeInput; node: GraphNodeInput }> = [];
  const targetSourceIds = relatedDocumentSourceIds(parsed);
  const documentsBySourceId = new Map(
    (
      await context.repository.findDocumentsBySourceIds({
        projectId: context.project.id,
        sourceIds: targetSourceIds,
      })
    ).map((document) => [document.sourceId, document]),
  );

  for (const targetSourceId of targetSourceIds) {
    const relation = parsed.relations.find(
      (candidate) => candidate.type === 'RELATED_TO' && candidate.target.trim() === targetSourceId,
    );
    const relatedDocument = documentsBySourceId.get(targetSourceId);
    if (!relation || !relatedDocument) {
      continue;
    }

    edges.push({
      edge: {
        fromGraphNodeId: target.document.graphNodeId,
        properties: {
          ...relation.metadata,
          projectId: context.project.id,
          relationTarget: targetSourceId,
          relationType: relation.type,
        },
        toGraphNodeId: relatedDocument.graphNodeId,
        type: 'RELATED_TO',
      },
      node: documentPlaceholderGraphNode(context.project, relatedDocument),
    });
  }

  return edges;
}

function relatedDocumentSourceIds(parsed: ParsedDocument): string[] {
  const sourceIds: string[] = [];
  const seenTargets = new Set<string>();
  for (const relation of parsed.relations) {
    if (relation.type !== 'RELATED_TO') {
      continue;
    }
    const targetSourceId = relation.target.trim();
    if (
      targetSourceId === '' ||
      targetSourceId === parsed.sourceId ||
      seenTargets.has(targetSourceId)
    ) {
      continue;
    }
    seenTargets.add(targetSourceId);
    sourceIds.push(targetSourceId);
  }
  return sourceIds;
}

function documentPlaceholderGraphNode(
  project: GraphRelationProjectRecord,
  document: GraphRelationDocumentRecord,
): GraphNodeInput {
  return {
    graphNodeId: document.graphNodeId,
    labels: ['Document', documentLabel(document.docType)],
    properties: {
      docType: document.docType,
      documentId: document.id,
      projectId: project.id,
      rawDocumentId: document.rawDocumentId,
      sourceId: document.sourceId,
    },
  };
}

function parsedTopicNodesAndEdges(
  project: GraphRelationProjectRecord,
  parsed: ParsedDocument,
  target: GraphRelationTarget,
): Array<{ edge: GraphEdgeInput; node: GraphNodeInput }> {
  return (parsed.topics ?? [])
    .filter((topic) => topic.target.trim() !== '')
    .map((topic) => {
      const topicGraphKeyTarget =
        topic.topicType === 'keyword' ? topic.target.toLowerCase() : topic.target;
      const topicGraphNodeId = `topic:${topic.topicType}:${encodeURIComponent(topicGraphKeyTarget)}`;
      return {
        edge: {
          fromGraphNodeId: target.document.graphNodeId,
          properties: {
            ...topic.metadata,
            projectId: project.id,
            relationTarget: topic.target,
            relationType: 'TOPIC',
          },
          toGraphNodeId: topicGraphNodeId,
          type: 'MENTIONS',
        },
        node: {
          graphNodeId: topicGraphNodeId,
          labels: ['Topic'],
          properties: {
            projectId: project.id,
            target: topic.target,
            topicType: topic.topicType,
          },
        },
      };
    });
}

function replyTopicNodesAndEdges(
  project: GraphRelationProjectRecord,
  parsed: ParsedDocument,
  target: GraphRelationTarget,
): Array<{ edge: GraphEdgeInput; node: GraphNodeInput }> {
  return parsed.relations
    .filter((relation) => relation.type === 'REPLY_TO' && relation.target.trim() !== '')
    .map((relation) => {
      const topicGraphNodeId = `topic:message:${encodeURIComponent(relation.target)}`;
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
          type: 'REPLY_TO',
        },
        node: {
          graphNodeId: topicGraphNodeId,
          labels: ['Topic'],
          properties: {
            projectId: project.id,
            target: relation.target,
            topicType: 'message',
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
  const resolvedActors = await Promise.all(
    quotes.map((quote, index) => {
      const sender = parseSenderAlias(quote.from);
      return findResolvedActor(
        context,
        parsed,
        { displayName: sender.displayName, email: sender.email, role: 'sender' },
        `quote:${index}`,
      );
    }),
  );
  const messageToIndex = new Map<string, number>();
  for (const [index, quote] of quotes.entries()) {
    messageToIndex.set(quote.messageId, index + 1);
  }

  return quotes.map((quote, index) => {
    const quoteIndex = index + 1;
    const senderActor = resolvedActors[index];
    const prevQuoteIndex =
      quote.prevMessageId === undefined ? undefined : messageToIndex.get(quote.prevMessageId);
    return {
      bodyText: quote.bodyText,
      prevQuoteIndex,
      quoteIndex,
      quotedMessageId: quote.messageId,
      senderActorId: senderActor?.id,
      senderAlias: quote.from,
      sentAt: quote.sentAt,
    };
  });
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
  const domain = mention.domain
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (email) {
    aliases.push({ aliasType: 'email', aliasValue: email });
  }
  if (githubLogin) {
    aliases.push({ aliasType: 'github_login', aliasValue: githubLogin });
  }
  if (domain) {
    aliases.push({ aliasType: 'domain', aliasValue: domain });
  }
  return aliases;
}

function isGraphNodeEdge(value: GraphNodeEdge | undefined): value is GraphNodeEdge {
  return value !== undefined;
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
