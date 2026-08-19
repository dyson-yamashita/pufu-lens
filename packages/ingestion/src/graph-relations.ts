import {
  type GraphIndexingActorRecord,
  type GraphIndexingDocumentRecord,
  type GraphIndexingEmailQuoteInput,
  type GraphIndexingRepository,
  type GraphIndexingTarget,
  type GraphMutationRepository,
  type GraphRelationType,
  type ProjectResolver,
  parseGraphIndexingDocumentType,
} from '@pufu-lens/graph';
import { parseSenderAlias } from './actor-resolution.js';
import {
  githubLifecycleGraphProperties,
  isGitHubLifecycleOnlyRefresh,
  readGitHubDocumentLifecycle,
} from './github-lifecycle.js';
import type { ActorMention, ParsedDocument, ParsedDocumentType } from './ingestion-fixtures.js';
import { validateParsedDocument } from './ingestion-fixtures.js';

/** Options for storing graph relations through separated provider-neutral collaborators. */
export interface StoreGraphRelationsOptions {
  readonly indexingRepository: GraphIndexingRepository;
  readonly limit: number;
  readonly mutationRepository: GraphMutationRepository;
  readonly projectResolver: ProjectResolver;
  readonly projectSlug: string;
}

/** Result of a graph relation indexing batch for one project slug. */
export interface StoreGraphRelationsResult {
  readonly decisions: readonly StoreGraphRelationDecision[];
  readonly projectSlug: string;
}

/** Per-document graph indexing decision emitted by `storeGraphRelations`. */
export interface StoreGraphRelationDecision {
  readonly actorEdgeCount: number;
  readonly decision: 'failed' | 'indexed';
  readonly documentId: string;
  readonly emailQuoteCount: number;
  readonly errorMessage?: string;
  readonly graphEdgeCount: number;
  readonly graphNodeCount: number;
  readonly rawDocumentId: string;
  readonly sameAsCount: number;
  readonly sourceId: string;
}

interface GraphRelationContext {
  readonly indexingRepository: GraphIndexingRepository;
  readonly mutationRepository: GraphMutationRepository;
  readonly projectId: string;
  readonly projectSlug: string;
}

type GraphIndexingActorAliasType = 'email' | 'github_login' | 'domain';

type MutationNodeEdge = {
  readonly edge: {
    readonly fromGraphNodeId: string;
    readonly properties: Record<string, unknown>;
    readonly relationType: GraphRelationType;
    readonly toGraphNodeId: string;
  };
  readonly node: {
    readonly graphNodeId: string;
    readonly labels: string[];
    readonly properties: Record<string, unknown>;
  };
};

/**
 * Indexes parsed documents into the project graph using separated resolver, indexing, and mutation collaborators.
 *
 * @param options - Project slug, bounded limit, and provider-neutral graph collaborators.
 */
export async function storeGraphRelations(
  options: StoreGraphRelationsOptions,
): Promise<StoreGraphRelationsResult> {
  const project = await options.projectResolver.resolveBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  await options.mutationRepository.ensureProjectGraph({ projectId: project.projectId });

  const targets = await options.indexingRepository.readGraphTargets({
    limit: options.limit,
    projectId: project.projectId,
  });
  const context: GraphRelationContext = {
    indexingRepository: options.indexingRepository,
    mutationRepository: options.mutationRepository,
    projectId: project.projectId,
    projectSlug: project.projectSlug,
  };
  const decisions: StoreGraphRelationDecision[] = [];

  for (const target of targets) {
    decisions.push(await storeGraphTargetSafely(context, target));
  }

  return { decisions, projectSlug: project.projectSlug };
}

async function storeGraphTargetSafely(
  context: GraphRelationContext,
  target: GraphIndexingTarget,
): Promise<StoreGraphRelationDecision> {
  try {
    return await storeGraphTarget(context, target);
  } catch (error) {
    const errorMessage = safeErrorMessage(error);
    await context.indexingRepository.markFailed({
      errorMessage,
      projectId: context.projectId,
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
  target: GraphIndexingTarget,
): Promise<StoreGraphRelationDecision> {
  const document = validatedIndexingDocument(target.document);
  const parsed = parseTargetDocument(target.parsed);
  validateDocumentGraphKey(document, parsed);

  if (isGitHubLifecycleOnlyRefresh(parsed.metadata)) {
    await upsertMutationNode(
      context,
      documentGraphNode(context.projectId, target, document, parsed),
    );
    await context.indexingRepository.markIndexed({
      projectId: context.projectId,
      rawDocumentId: target.rawDocumentId,
    });
    return {
      actorEdgeCount: 0,
      decision: 'indexed',
      documentId: document.id,
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

  await upsertMutationNode(context, documentGraphNode(context.projectId, target, document, parsed));
  graphNodeCount += 1;

  for (const actorEdge of await actorEdges(context, parsed, document.graphNodeId)) {
    await upsertMutationNode(context, actorEdge.node);
    await upsertMutationEdge(context, actorEdge.edge);
    graphNodeCount += 1;
    graphEdgeCount += 1;
    actorEdgeCount += 1;
  }

  for (const topicNodeEdge of topicNodesAndEdges(context.projectId, parsed, document)) {
    await upsertMutationNode(context, topicNodeEdge.node);
    await upsertMutationEdge(context, topicNodeEdge.edge);
    graphNodeCount += 1;
    graphEdgeCount += 1;
  }

  for (const documentEdge of await relatedDocumentEdges(context, parsed, document)) {
    await upsertMutationNode(context, documentEdge.node);
    await upsertMutationEdge(context, documentEdge.edge);
    graphNodeCount += 1;
    graphEdgeCount += 1;
  }

  const emailQuotes = await resolvedEmailQuotes(context, parsed);
  await context.indexingRepository.replaceEmailQuotes({
    documentId: document.id,
    projectId: context.projectId,
    quotes: emailQuotes,
  });

  for (const sameAsDocument of await context.indexingRepository.findSameAsDocuments({
    projectId: context.projectId,
    rawContentHash: target.rawContentHash,
    rawDocumentId: target.rawDocumentId,
    sourceType: parsed.sourceType,
  })) {
    await upsertMutationEdge(context, {
      fromGraphNodeId: document.graphNodeId,
      properties: {
        confidence: 1,
        projectId: context.projectId,
        reason: 'content_hash_match',
      },
      relationType: 'SAME_AS',
      toGraphNodeId: validatedIndexingDocument(sameAsDocument).graphNodeId,
    });
    graphEdgeCount += 1;
    sameAsCount += 1;
  }

  await context.indexingRepository.markIndexed({
    projectId: context.projectId,
    rawDocumentId: target.rawDocumentId,
  });

  return {
    actorEdgeCount,
    decision: 'indexed',
    documentId: document.id,
    emailQuoteCount: emailQuotes.length,
    graphEdgeCount,
    graphNodeCount,
    rawDocumentId: target.rawDocumentId,
    sameAsCount,
    sourceId: parsed.sourceId,
  };
}

async function upsertMutationNode(
  context: GraphRelationContext,
  node: MutationNodeEdge['node'],
): Promise<void> {
  await context.mutationRepository.upsertNode({
    graphNodeId: node.graphNodeId,
    labels: node.labels,
    projectId: context.projectId,
    properties: node.properties,
  });
}

async function upsertMutationEdge(
  context: GraphRelationContext,
  edge: MutationNodeEdge['edge'],
): Promise<void> {
  await context.mutationRepository.upsertEdge({
    fromGraphNodeId: edge.fromGraphNodeId,
    projectId: context.projectId,
    properties: edge.properties,
    relationType: edge.relationType,
    toGraphNodeId: edge.toGraphNodeId,
  });
}

function validatedIndexingDocument(
  document: GraphIndexingDocumentRecord,
): GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType } {
  return {
    ...document,
    docType: parseGraphIndexingDocumentType(document.docType) as ParsedDocumentType,
  };
}

function documentGraphNode(
  projectId: string,
  target: GraphIndexingTarget,
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
  parsed: ParsedDocument,
): MutationNodeEdge['node'] {
  const lifecycle = readGitHubDocumentLifecycle(parsed.metadata);
  return {
    graphNodeId: document.graphNodeId,
    labels: ['Document', documentLabel(document.docType)],
    properties: {
      canonicalUri: parsed.canonicalUri,
      docType: parsed.docType,
      documentId: document.id,
      occurredAt: parsed.occurredAt,
      projectId,
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
): Promise<MutationNodeEdge[]> {
  const edges: Array<MutationNodeEdge | undefined> = await Promise.all(
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
          relationType: actorEdgeType(mention.role),
          toGraphNodeId: documentGraphNodeId,
        },
        node: {
          graphNodeId: actor.graphNodeId,
          labels: ['Actor'],
          properties: {
            actorId: actor.id,
            displayName: actor.displayName,
            projectId: context.projectId,
          },
        },
      };
    }),
  );
  return edges.filter(isMutationNodeEdge);
}

function topicNodesAndEdges(
  projectId: string,
  parsed: ParsedDocument,
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
): MutationNodeEdge[] {
  return [
    ...parsedTopicNodesAndEdges(projectId, parsed, document),
    ...replyTopicNodesAndEdges(projectId, parsed, document),
  ];
}

async function relatedDocumentEdges(
  context: GraphRelationContext,
  parsed: ParsedDocument,
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
): Promise<MutationNodeEdge[]> {
  const edges: MutationNodeEdge[] = [];
  const targetSourceIds = relatedDocumentSourceIds(parsed);
  const documentsBySourceId = new Map(
    (
      await context.indexingRepository.findDocumentsBySourceIds({
        projectId: context.projectId,
        sourceIds: targetSourceIds,
      })
    ).map((candidate) => [candidate.sourceId, validatedIndexingDocument(candidate)]),
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
        fromGraphNodeId: document.graphNodeId,
        properties: {
          ...relation.metadata,
          projectId: context.projectId,
          relationTarget: targetSourceId,
          relationType: relation.type,
        },
        relationType: 'RELATED_TO',
        toGraphNodeId: relatedDocument.graphNodeId,
      },
      node: documentPlaceholderGraphNode(context.projectId, relatedDocument),
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
  projectId: string,
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
): MutationNodeEdge['node'] {
  return {
    graphNodeId: document.graphNodeId,
    labels: ['Document', documentLabel(document.docType)],
    properties: {
      docType: document.docType,
      documentId: document.id,
      projectId,
      rawDocumentId: document.rawDocumentId,
      sourceId: document.sourceId,
    },
  };
}

function parsedTopicNodesAndEdges(
  projectId: string,
  parsed: ParsedDocument,
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
): MutationNodeEdge[] {
  return (parsed.topics ?? [])
    .filter((topic) => topic.target.trim() !== '')
    .map((topic) => {
      const topicGraphKeyTarget =
        topic.topicType === 'keyword' ? topic.target.toLowerCase() : topic.target;
      const topicGraphNodeId = `topic:${topic.topicType}:${encodeURIComponent(topicGraphKeyTarget)}`;
      return {
        edge: {
          fromGraphNodeId: document.graphNodeId,
          properties: {
            ...topic.metadata,
            projectId,
            relationTarget: topic.target,
            relationType: 'TOPIC',
          },
          relationType: 'MENTIONS',
          toGraphNodeId: topicGraphNodeId,
        },
        node: {
          graphNodeId: topicGraphNodeId,
          labels: ['Topic'],
          properties: {
            projectId,
            target: topic.target,
            topicType: topic.topicType,
          },
        },
      };
    });
}

function replyTopicNodesAndEdges(
  projectId: string,
  parsed: ParsedDocument,
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
): MutationNodeEdge[] {
  return parsed.relations
    .filter((relation) => relation.type === 'REPLY_TO' && relation.target.trim() !== '')
    .map((relation) => {
      const topicGraphNodeId = `topic:message:${encodeURIComponent(relation.target)}`;
      return {
        edge: {
          fromGraphNodeId: document.graphNodeId,
          properties: {
            ...relation.metadata,
            projectId,
            relationTarget: relation.target,
            relationType: relation.type,
          },
          relationType: 'REPLY_TO',
          toGraphNodeId: topicGraphNodeId,
        },
        node: {
          graphNodeId: topicGraphNodeId,
          labels: ['Topic'],
          properties: {
            projectId,
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
): Promise<GraphIndexingEmailQuoteInput[]> {
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
): Promise<GraphIndexingActorRecord | undefined> {
  for (const alias of strongAliases(mention)) {
    const actor = await context.indexingRepository.findActorByAlias({
      aliasType: alias.aliasType,
      aliasValue: alias.aliasValue,
      projectId: context.projectId,
    });
    if (actor) {
      return actor;
    }
  }

  return context.indexingRepository.findActorByGraphNodeId({
    graphNodeId: unresolvedActorGraphNodeId({
      displayName: mention.displayName,
      occurrenceKey,
      sourceId: parsed.sourceId,
    }),
    projectId: context.projectId,
  });
}

function strongAliases(
  mention: ActorMention,
): Array<{ aliasType: GraphIndexingActorAliasType; aliasValue: string }> {
  const aliases: Array<{ aliasType: GraphIndexingActorAliasType; aliasValue: string }> = [];
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

function isMutationNodeEdge(value: MutationNodeEdge | undefined): value is MutationNodeEdge {
  return value !== undefined;
}

function validateDocumentGraphKey(
  document: GraphIndexingDocumentRecord & { readonly docType: ParsedDocumentType },
  parsed: ParsedDocument,
): void {
  const expected = documentGraphNodeId(parsed);
  if (document.graphNodeId !== expected) {
    throw new Error(
      `Document graph key mismatch for ${parsed.sourceId}: expected ${expected}, got ${document.graphNodeId}`,
    );
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

function actorEdgeType(role: ActorMention['role']): GraphRelationType {
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

function parseTargetDocument(value: unknown): ParsedDocument {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as ParsedDocument) : (value as ParsedDocument);
  return validateParsedDocument(parsed);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}

function sourceIdForFailure(target: GraphIndexingTarget): string {
  try {
    return parseTargetDocument(target.parsed).sourceId;
  } catch {
    return target.document.graphNodeId;
  }
}
