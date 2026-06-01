import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GraphActorRecord,
  type GraphEdgeInput,
  type GraphEmailQuoteInput,
  type GraphNodeInput,
  type GraphRelationDocumentTarget,
  type GraphRelationRepository,
  indexGraphRelations,
} from './graph-relations.js';
import type { ParsedDocument } from './ingestion-fixtures.js';

test('indexGraphRelations materializes document, actor, topic edges, and email quotes', async () => {
  const parsed = parsedDocument({
    actors: [
      {
        displayName: 'Alice',
        githubLogin: 'alice',
        role: 'author',
      },
      {
        displayName: 'Bob',
        email: 'bob@example.test',
        role: 'reviewer',
      },
    ],
    emailQuotes: [
      {
        bodyText: 'Older message',
        from: 'Bob <bob@example.test>',
        messageId: 'message-1',
        sentAt: '2026-05-30T10:00:00.000Z',
      },
      {
        bodyText: 'Oldest message',
        from: 'Carol <carol@example.test>',
        messageId: 'message-0',
        prevMessageId: 'message-1',
        sentAt: '2026-05-30T09:00:00.000Z',
      },
    ],
    relations: [
      {
        metadata: { commentId: 1001 },
        target: 'owner/repo#101',
        type: 'COMMENTED_ON',
      },
      {
        target: 'https://example.test/roadmap',
        type: 'LINKS_TO',
      },
    ],
  });
  const repository = new InMemoryGraphRelationRepository([
    {
      docType: parsed.docType,
      documentId: 'document-1',
      graphNodeId: 'document:issue:github%3Aowner%2Frepo%23101',
      parsed,
      rawDocumentId: 'raw-1',
      title: parsed.title,
    },
  ]);

  const result = await indexGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal(result.decisions[0]?.graphNodes, 5);
  assert.equal(result.decisions[0]?.actorEdges, 2);
  assert.equal(result.decisions[0]?.relationEdges, 2);
  assert.equal(result.decisions[0]?.emailQuotes, 2);
  assert.deepEqual(repository.nodes.map((node) => `${node.label}:${node.key}`).sort(), [
    'Actor:actor:email:bob%40example.test',
    'Actor:actor:github_login:alice',
    'Document:document:issue:github%3Aowner%2Frepo%23101',
    'Topic:topic:commented_on:owner%2Frepo%23101',
    'Topic:topic:links_to:https%3A%2F%2Fexample.test%2Froadmap',
  ]);
  assert.deepEqual(repository.edges.map((edge) => edge.type).sort(), [
    'COMMENTED_ON',
    'LINKS_TO',
    'MENTIONS',
    'MENTIONS',
  ]);
  assert.equal(repository.emailQuotes[1]?.prevQuoteIndex, 1);
  assert.deepEqual(repository.indexedRawDocuments, ['raw-1']);
});

test('indexGraphRelations is idempotent through stable graph keys', async () => {
  const parsed = parsedDocument({
    actors: [{ displayName: 'Alice', githubLogin: 'alice', role: 'author' }],
    relations: [{ target: 'owner/repo#101', type: 'SAME_AS_CANDIDATE' }],
  });
  const repository = new InMemoryGraphRelationRepository([
    {
      docType: parsed.docType,
      documentId: 'document-1',
      graphNodeId: 'document:issue:github%3Aowner%2Frepo%23101',
      parsed,
      rawDocumentId: 'raw-1',
      title: parsed.title,
    },
  ]);
  const options = { limit: 10, projectSlug: 'sample-a', repository };

  await indexGraphRelations(options);
  await indexGraphRelations(options);

  assert.equal(repository.nodes.length, 3);
  assert.equal(repository.edges.length, 2);
  assert.deepEqual(repository.edges.map((edge) => edge.type).sort(), ['MENTIONS', 'SAME_AS']);
  assert.deepEqual(repository.indexedRawDocuments, ['raw-1', 'raw-1']);
});

test('indexGraphRelations rejects a mismatched document graph key', async () => {
  const parsed = parsedDocument();
  const repository = new InMemoryGraphRelationRepository([
    {
      docType: parsed.docType,
      documentId: 'document-1',
      graphNodeId: 'document:issue:wrong',
      parsed,
      rawDocumentId: 'raw-1',
      title: parsed.title,
    },
  ]);

  await assert.rejects(
    () => indexGraphRelations({ limit: 10, projectSlug: 'sample-a', repository }),
    /Document graph_node_id mismatch/,
  );
});

class InMemoryGraphRelationRepository implements GraphRelationRepository {
  readonly actors: GraphActorRecord[] = [
    {
      displayName: 'Alice',
      graphNodeId: 'actor:github_login:alice',
      id: 'actor-1',
      primaryLogin: 'alice',
    },
    {
      displayName: 'Bob',
      graphNodeId: 'actor:email:bob%40example.test',
      id: 'actor-2',
      primaryEmail: 'bob@example.test',
    },
    {
      displayName: 'Carol',
      graphNodeId: 'actor:email:carol%40example.test',
      id: 'actor-3',
      primaryEmail: 'carol@example.test',
    },
  ];
  readonly edges: GraphEdgeInput[] = [];
  readonly emailQuotes: GraphEmailQuoteInput[] = [];
  readonly indexedRawDocuments: string[] = [];
  readonly nodes: GraphNodeInput[] = [];
  readonly project = { graphName: 'graph_sample_a', id: 'project-1', slug: 'sample-a' };

  constructor(readonly targets: GraphRelationDocumentTarget[]) {}

  async lookupProjectBySlug(slug: string) {
    return slug === this.project.slug ? this.project : undefined;
  }

  async listDocumentsForGraph(input: { limit: number; projectId: string }) {
    assert.equal(input.projectId, this.project.id);
    return this.targets.slice(0, input.limit);
  }

  async findActorByAlias(input: {
    aliasType: 'email' | 'github_login';
    aliasValue: string;
    projectId: string;
  }) {
    assert.equal(input.projectId, this.project.id);
    return this.actors.find((actor) =>
      input.aliasType === 'email'
        ? actor.primaryEmail === input.aliasValue
        : actor.primaryLogin === input.aliasValue,
    );
  }

  async mergeGraphNode(input: GraphNodeInput) {
    if (!this.nodes.some((node) => node.graphName === input.graphName && node.key === input.key)) {
      this.nodes.push(input);
    }
  }

  async mergeGraphEdge(input: GraphEdgeInput) {
    if (!this.edges.some((edge) => edge.graphName === input.graphName && edge.key === input.key)) {
      this.edges.push(input);
    }
  }

  async replaceEmailQuotes(input: {
    documentId: string;
    projectId: string;
    quotes: GraphEmailQuoteInput[];
  }) {
    for (let index = this.emailQuotes.length - 1; index >= 0; index -= 1) {
      const quote = this.emailQuotes[index];
      if (quote?.projectId === input.projectId && quote.documentId === input.documentId) {
        this.emailQuotes.splice(index, 1);
      }
    }
    this.emailQuotes.push(...input.quotes);
  }

  async markIndexed(input: { projectId: string; rawDocumentId: string }) {
    assert.equal(input.projectId, this.project.id);
    this.indexedRawDocuments.push(input.rawDocumentId);
  }
}

function parsedDocument(input: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    actors: [],
    bodyText: 'Body text for graph indexing.',
    canonicalUri: 'https://example.test/doc',
    docType: 'issue',
    metadata: {},
    occurredAt: '2026-05-31T00:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'github:owner/repo#101',
    sourceType: 'github',
    title: 'Fixture title',
    ...input,
  };
}
