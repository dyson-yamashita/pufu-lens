import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GraphEdgeInput,
  type GraphEmailQuoteInput,
  type GraphNodeInput,
  type GraphRelationActorRecord,
  type GraphRelationDocumentRecord,
  type GraphRelationsRepository,
  type GraphRelationTarget,
  type ReplaceEmailQuotesInput,
  storeGraphRelations,
} from './graph-relations.js';
import type { ParsedDocument } from './ingestion-fixtures.js';

test('storeGraphRelations materializes document, actor, topic, quote, and status updates idempotently', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord(),
      parsed: gmailParsed(),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);
  repository.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  repository.aliases.set(
    'email:sender@example.test',
    repository.actors.at(-1) as GraphRelationActorRecord,
  );
  repository.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  repository.aliases.set(
    'email:reviewer@example.test',
    repository.actors.at(-1) as GraphRelationActorRecord,
  );

  const first = await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });
  const second = await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal(first.decisions[0]?.decision, 'indexed');
  assert.equal(first.decisions[0]?.actorEdgeCount, 2);
  assert.equal(first.decisions[0]?.emailQuoteCount, 1);
  assert.equal(repository.nodes.size, 4);
  assert.equal(repository.edges.size, 3);
  assert.equal(repository.emailQuotes.get('document-email-1')?.length, 1);
  assert.deepEqual(repository.statusUpdates, [
    { projectId: 'project-a', rawDocumentId: 'raw-email-1' },
    { projectId: 'project-a', rawDocumentId: 'raw-email-1' },
  ]);
  assert.equal(second.decisions[0]?.graphNodeCount, first.decisions[0]?.graphNodeCount);
  assert.equal(repository.edges.size, 3);
});

test('storeGraphRelations resolves quote chains without depending on quote order', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord(),
      parsed: gmailParsed({
        emailQuotes: [
          {
            bodyText: 'Newest quoted message.',
            from: 'Sample Reviewer <reviewer@example.test>',
            messageId: 'msg-alpha-002',
            prevMessageId: 'msg-alpha-001',
            sentAt: '2026-05-05T14:50:00.000Z',
          },
          {
            bodyText: 'Older quoted message.',
            from: 'Sample Sender <sender@example.test>',
            messageId: 'msg-alpha-001',
            sentAt: '2026-05-05T14:10:00.000Z',
          },
        ],
      }),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);
  repository.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  repository.aliases.set(
    'email:sender@example.test',
    repository.actors.at(-1) as GraphRelationActorRecord,
  );
  repository.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  repository.aliases.set(
    'email:reviewer@example.test',
    repository.actors.at(-1) as GraphRelationActorRecord,
  );

  await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.deepEqual(
    repository.emailQuotes.get('document-email-1')?.map((quote) => ({
      prevQuoteIndex: quote.prevQuoteIndex,
      quoteIndex: quote.quoteIndex,
      quotedMessageId: quote.quotedMessageId,
    })),
    [
      { prevQuoteIndex: 2, quoteIndex: 1, quotedMessageId: 'msg-alpha-002' },
      { prevQuoteIndex: undefined, quoteIndex: 2, quotedMessageId: 'msg-alpha-001' },
    ],
  );
});

test('storeGraphRelations creates SAME_AS only for another source type in the same project', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord({
        docType: 'drive_doc',
        graphNodeId: 'document:drive_doc:drive%3Afile-1%3Arev-1',
        id: 'document-drive-1',
        rawDocumentId: 'raw-drive-1',
      }),
      parsed: driveParsed(),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-drive-1',
    },
  ]);
  repository.sameAsDocuments.push({
    docType: 'web_page',
    graphNodeId: 'document:web_page:https%3A%2F%2Fexample.test%2Fspec',
    id: 'document-web-1',
    rawDocumentId: 'raw-web-1',
  });

  const result = await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal(result.decisions[0]?.sameAsCount, 1);
  assert.ok(
    repository.hasEdge(
      'document:drive_doc:drive%3Afile-1%3Arev-1',
      'SAME_AS',
      'document:web_page:https%3A%2F%2Fexample.test%2Fspec',
    ),
  );
});

test('storeGraphRelations materializes parsed keyword topics as mentions', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord(),
      parsed: gmailParsed({
        relations: [{ target: 'https://example.test/ignored', type: 'LINKS_TO' }],
        topics: [
          {
            metadata: { source: 'title' },
            target: 'Release Notes',
            topicType: 'keyword',
          },
        ],
      }),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);

  await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.ok(repository.nodes.has('topic:keyword:Release%20Notes'));
  assert.ok(
    repository.hasEdge(
      'document:email:thread-alpha%3Amsg-alpha-003',
      'MENTIONS',
      'topic:keyword:Release%20Notes',
    ),
  );
  assert.equal(repository.nodes.has('topic:uri:https%3A%2F%2Fexample.test%2Fignored'), false);
});

test('storeGraphRelations skips blank reply relation targets', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord(),
      parsed: gmailParsed({
        relations: [{ target: '   ', type: 'REPLY_TO' }],
      }),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);

  await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal([...repository.nodes.keys()].filter((key) => key.startsWith('topic:')).length, 0);
});

test('storeGraphRelations rejects stale document graph keys before writing graph data', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord({ graphNodeId: 'document:issue:stale' }),
      parsed: githubParsed(),
      rawContentHash: 'hash-1',
      rawDocumentId: 'raw-github-1',
    },
  ]);

  const result = await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal(result.decisions[0]?.decision, 'failed');
  assert.match(result.decisions[0]?.errorMessage ?? '', /Document graph key mismatch/);
  assert.deepEqual(repository.failureUpdates, [
    {
      errorMessage:
        'Document graph key mismatch for example-org/pufu-sample/issues/101: expected document:issue:example-org%2Fpufu-sample%2Fissues%2F101, got document:issue:stale',
      projectId: 'project-a',
      rawDocumentId: 'raw-github-1',
    },
  ]);
  assert.equal(repository.nodes.size, 0);
  assert.equal(repository.edges.size, 0);
});

test('storeGraphRelations continues after a failed document', async () => {
  const repository = new InMemoryGraphRelationsRepository([
    {
      document: documentRecord({ graphNodeId: 'document:issue:stale', id: 'document-bad' }),
      parsed: githubParsed(),
      rawContentHash: 'hash-1',
      rawDocumentId: 'raw-github-1',
    },
    {
      document: documentRecord(),
      parsed: gmailParsed(),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);
  repository.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  repository.aliases.set(
    'email:sender@example.test',
    repository.actors.at(-1) as GraphRelationActorRecord,
  );
  repository.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  repository.aliases.set(
    'email:reviewer@example.test',
    repository.actors.at(-1) as GraphRelationActorRecord,
  );

  const result = await storeGraphRelations({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.deepEqual(
    result.decisions.map((decision) => decision.decision),
    ['failed', 'indexed'],
  );
  assert.deepEqual(
    repository.failureUpdates.map((update) => update.rawDocumentId),
    ['raw-github-1'],
  );
  assert.deepEqual(
    repository.statusUpdates.map((update) => update.rawDocumentId),
    ['raw-email-1'],
  );
});

test('storeGraphRelations keeps project slug isolation at repository boundary', async () => {
  const repository = new InMemoryGraphRelationsRepository([]);

  await assert.rejects(
    () =>
      storeGraphRelations({
        limit: 10,
        projectSlug: 'sample-b',
        repository,
      }),
    /Project not found/,
  );
});

class InMemoryGraphRelationsRepository implements GraphRelationsRepository {
  readonly aliases = new Map<string, GraphRelationActorRecord>();
  readonly actors: GraphRelationActorRecord[] = [];
  readonly edges = new Map<string, GraphEdgeInput>();
  readonly emailQuotes = new Map<string, GraphEmailQuoteInput[]>();
  readonly nodes = new Map<string, GraphNodeInput>();
  readonly project = { graphName: 'graph_sample_a', id: 'project-a', slug: 'sample-a' };
  readonly sameAsDocuments: GraphRelationDocumentRecord[] = [];
  readonly failureUpdates: Array<{
    errorMessage: string;
    projectId: string;
    rawDocumentId: string;
  }> = [];
  readonly statusUpdates: Array<{ projectId: string; rawDocumentId: string }> = [];

  constructor(private readonly targets: GraphRelationTarget[]) {}

  async lookupProjectBySlug(slug: string) {
    return slug === this.project.slug ? this.project : undefined;
  }

  async readGraphTargets(input: { limit: number; projectId: string }) {
    assert.equal(input.projectId, this.project.id);
    return this.targets.slice(0, input.limit);
  }

  async findActorByAlias(input: {
    aliasType: 'email' | 'github_login';
    aliasValue: string;
    projectId: string;
  }) {
    assert.equal(input.projectId, this.project.id);
    return this.aliases.get(`${input.aliasType}:${input.aliasValue}`);
  }

  async findActorByGraphNodeId(input: { graphNodeId: string; projectId: string }) {
    assert.equal(input.projectId, this.project.id);
    return this.actors.find((actor) => actor.graphNodeId === input.graphNodeId);
  }

  async findSameAsDocuments(input: {
    projectId: string;
    rawContentHash: string;
    rawDocumentId: string;
    sourceType: ParsedDocument['sourceType'];
  }) {
    assert.equal(input.projectId, this.project.id);
    if (input.rawContentHash !== 'same-hash') {
      return [];
    }
    return this.sameAsDocuments.filter(
      (document) => document.rawDocumentId !== input.rawDocumentId,
    );
  }

  async upsertGraphNode(input: GraphNodeInput) {
    this.nodes.set(input.graphNodeId, input);
  }

  async upsertGraphEdge(input: GraphEdgeInput) {
    this.edges.set(edgeKey(input), input);
  }

  async replaceEmailQuotes(input: ReplaceEmailQuotesInput) {
    assert.equal(input.projectId, this.project.id);
    this.emailQuotes.set(input.documentId, input.quotes);
  }

  async markFailed(input: { errorMessage: string; projectId: string; rawDocumentId: string }) {
    this.failureUpdates.push(input);
  }

  async markIndexed(input: { projectId: string; rawDocumentId: string }) {
    this.statusUpdates.push(input);
  }

  hasEdge(fromGraphNodeId: string, type: string, toGraphNodeId: string): boolean {
    return this.edges.has(`${fromGraphNodeId}:${type}:${toGraphNodeId}`);
  }
}

function edgeKey(input: GraphEdgeInput): string {
  return `${input.fromGraphNodeId}:${input.type}:${input.toGraphNodeId}`;
}

function documentRecord(
  input: Partial<GraphRelationDocumentRecord> = {},
): GraphRelationDocumentRecord {
  return {
    docType: 'email',
    graphNodeId: 'document:email:thread-alpha%3Amsg-alpha-003',
    id: 'document-email-1',
    rawDocumentId: 'raw-email-1',
    ...input,
  };
}

function gmailParsed(
  input: Partial<Pick<ParsedDocument, 'emailQuotes' | 'relations' | 'topics'>> = {},
): ParsedDocument {
  return {
    actors: [
      { displayName: 'Sample Sender', email: 'sender@example.test', role: 'sender' },
      { displayName: 'Sample Reviewer', email: 'reviewer@example.test', role: 'commenter' },
    ],
    bodyText: 'Latest update.',
    canonicalUri: 'gmail://thread-alpha/msg-alpha-003',
    docType: 'email',
    emailQuotes: input.emailQuotes ?? [
      {
        bodyText: 'Previous update.',
        from: 'Sample Reviewer <reviewer@example.test>',
        messageId: 'msg-alpha-002',
        sentAt: '2026-05-05T14:50:00.000Z',
      },
    ],
    metadata: {},
    occurredAt: '2026-05-05T15:20:00.000Z',
    relations: input.relations ?? [{ target: 'msg-alpha-002', type: 'REPLY_TO' }],
    schemaVersion: 1,
    sourceId: 'thread-alpha:msg-alpha-003',
    sourceType: 'gmail',
    title: 'Fixture ingestion review',
    topics: input.topics,
  };
}

function githubParsed(): ParsedDocument {
  return {
    actors: [{ displayName: 'Sample Author', githubLogin: 'sample-author', role: 'author' }],
    bodyText: 'Issue body',
    canonicalUri: 'https://github.com/example-org/pufu-sample/issues/101',
    docType: 'issue',
    metadata: {},
    occurredAt: '2026-05-01T09:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'example-org/pufu-sample/issues/101',
    sourceType: 'github',
    title: 'Indexer should skip archived notes',
  };
}

function driveParsed(): ParsedDocument {
  return {
    actors: [],
    bodyText: 'Shared spec content.',
    canonicalUri: 'https://drive.example.test/file-1',
    docType: 'drive_doc',
    metadata: {},
    occurredAt: '2026-05-02T09:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'drive:file-1:rev-1',
    sourceType: 'drive',
    title: 'Spec draft',
  };
}
