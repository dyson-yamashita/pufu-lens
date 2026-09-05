import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  GraphIndexingActorRecord,
  GraphIndexingDocumentRecord,
  GraphIndexingEmailQuoteInput,
  GraphIndexingRepository,
  GraphIndexingTarget,
  GraphMutationRepository,
  GraphRelationType,
  ProjectResolver,
} from '@pufu-lens/graph';
import { storeGraphRelations } from './graph-relations.js';
import type { ParsedDocument } from './ingestion-fixtures.js';

test('storeGraphRelations materializes document, actor, topic, quote, and status updates idempotently', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord(),
      parsed: gmailParsed(),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);
  fixture.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  fixture.aliases.set(
    'email:sender@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );
  fixture.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  fixture.aliases.set(
    'email:reviewer@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );

  const first = await storeGraphRelations(fixture.storeOptions());
  const second = await storeGraphRelations(fixture.storeOptions());

  assert.equal(first.decisions[0]?.decision, 'indexed');
  assert.equal(first.decisions[0]?.actorEdgeCount, 2);
  assert.equal(first.decisions[0]?.emailQuoteCount, 1);
  assert.equal(fixture.nodes.size, 4);
  assert.equal(fixture.edges.size, 3);
  assert.equal(fixture.emailQuotes.get('document-email-1')?.length, 1);
  assert.deepEqual(fixture.statusUpdates, [
    { projectId: 'project-a', rawDocumentId: 'raw-email-1' },
    { projectId: 'project-a', rawDocumentId: 'raw-email-1' },
  ]);
  assert.equal(second.decisions[0]?.graphNodeCount, first.decisions[0]?.graphNodeCount);
  assert.equal(fixture.edges.size, 3);
});

test('storeGraphRelations rebuild mode materializes lifecycle-only targets with full graph edges', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord({
        docType: 'issue',
        graphNodeId: 'document:issue:example-org%2Fpufu-sample%2Fissues%2F101',
        id: 'document-github-1',
        rawDocumentId: 'raw-github-1',
      }),
      parsed: githubParsed({
        metadata: {
          githubLifecycle: {
            closedAt: '2026-05-08T12:00:00.000Z',
            draft: null,
            kind: 'issue',
            merged: null,
            mergedAt: null,
            state: 'closed',
            stateReason: 'completed',
            statusKnown: true,
            updatedAt: '2026-05-08T12:00:00.000Z',
          },
          lifecycleOnly: true,
        },
        topics: [
          {
            metadata: { source: 'title' },
            target: 'Lifecycle rebuild',
            topicType: 'keyword',
          },
        ],
      }),
      rawContentHash: 'github-hash',
      rawDocumentId: 'raw-github-1',
    },
  ]);
  fixture.actors.push({
    displayName: 'Sample Author',
    graphNodeId: 'actor:github:sample-author',
    id: 'actor-github-author',
  });
  fixture.aliases.set(
    'github_login:sample-author',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );

  const incremental = await storeGraphRelations(fixture.storeOptions());
  assert.equal(incremental.decisions[0]?.graphEdgeCount, 0);

  const rebuild = await storeGraphRelations({
    ...fixture.storeOptions(),
    mode: 'rebuild',
  });

  assert.equal(rebuild.decisions[0]?.decision, 'indexed');
  assert.equal(rebuild.decisions[0]?.actorEdgeCount, 1);
  assert.equal(rebuild.decisions[0]?.graphEdgeCount, 2);
  assert.ok(fixture.nodes.has('topic:keyword:lifecycle%20rebuild'));
});

test('storeGraphRelations updates GitHub lifecycle properties without recreating edges', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord({
        docType: 'issue',
        graphNodeId: 'document:issue:example-org%2Fpufu-sample%2Fissues%2F101',
        id: 'document-github-1',
        rawDocumentId: 'raw-github-1',
      }),
      parsed: githubParsed({
        metadata: {
          githubLifecycle: {
            closedAt: '2026-05-08T12:00:00.000Z',
            draft: null,
            kind: 'issue',
            merged: null,
            mergedAt: null,
            state: 'closed',
            stateReason: 'completed',
            statusKnown: true,
            updatedAt: '2026-05-08T12:00:00.000Z',
          },
          lifecycleOnly: true,
        },
      }),
      rawContentHash: 'github-hash',
      rawDocumentId: 'raw-github-1',
    },
  ]);

  const result = await storeGraphRelations(fixture.storeOptions());

  assert.equal(result.decisions[0]?.decision, 'indexed');
  assert.equal(result.decisions[0]?.graphEdgeCount, 0);
  assert.equal(result.decisions[0]?.graphNodeCount, 1);
  const documentNode = [...fixture.nodes.values()].find((node) => node.labels.includes('Document'));
  assert.equal(documentNode?.properties.state, 'closed');
});

test('storeGraphRelations resolves web authors by domain alias', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord({
        docType: 'web_page',
        graphNodeId: 'document:web_page:https%3A%2F%2Fnote.example.test%2Fsample-writer%2Fpost-1',
        id: 'document-web-1',
        rawDocumentId: 'raw-web-1',
      }),
      parsed: webParsed(),
      rawContentHash: 'web-hash',
      rawDocumentId: 'raw-web-1',
    },
  ]);
  fixture.actors.push({
    displayName: 'Sample Writer',
    graphNodeId: 'actor:domain:note.example.test%2Fsample-writer',
    id: 'actor-web-writer',
  });
  fixture.aliases.set(
    'domain:note.example.test/sample-writer',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );

  const result = await storeGraphRelations(fixture.storeOptions());

  assert.equal(result.decisions[0]?.actorEdgeCount, 1);
  assert.ok(
    fixture.hasEdge(
      'actor:domain:note.example.test%2Fsample-writer',
      'AUTHORED',
      'document:web_page:https%3A%2F%2Fnote.example.test%2Fsample-writer%2Fpost-1',
    ),
  );
});

test('storeGraphRelations resolves quote chains without depending on quote order', async () => {
  const fixture = new InMemoryGraphFixture([
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
  fixture.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  fixture.aliases.set(
    'email:sender@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );
  fixture.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  fixture.aliases.set(
    'email:reviewer@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );

  await storeGraphRelations(fixture.storeOptions());

  assert.deepEqual(
    fixture.emailQuotes.get('document-email-1')?.map((quote) => ({
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
  const fixture = new InMemoryGraphFixture([
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
  fixture.sameAsDocuments.push({
    docType: 'web_page',
    graphNodeId: 'document:web_page:https%3A%2F%2Fexample.test%2Fspec',
    id: 'document-web-1',
    rawDocumentId: 'raw-web-1',
    sourceId: 'https://example.test/spec',
  });

  const result = await storeGraphRelations(fixture.storeOptions());

  assert.equal(result.decisions[0]?.sameAsCount, 1);
  assert.ok(
    fixture.hasEdge(
      'document:drive_doc:drive%3Afile-1%3Arev-1',
      'SAME_AS',
      'document:web_page:https%3A%2F%2Fexample.test%2Fspec',
    ),
  );
});

test('storeGraphRelations materializes parsed keyword topics as mentions', async () => {
  const fixture = new InMemoryGraphFixture([
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

  await storeGraphRelations(fixture.storeOptions());

  assert.ok(fixture.nodes.has('topic:keyword:release%20notes'));
  assert.ok(
    fixture.hasEdge(
      'document:email:thread-alpha%3Amsg-alpha-003',
      'MENTIONS',
      'topic:keyword:release%20notes',
    ),
  );
  assert.equal(
    fixture.nodes.get('topic:keyword:release%20notes')?.properties.target,
    'Release Notes',
  );
  assert.equal(fixture.nodes.has('topic:uri:https%3A%2F%2Fexample.test%2Fignored'), false);
});

test('storeGraphRelations materializes parsed Drive keyword topics as mentions', async () => {
  const driveDocument = documentRecord({
    docType: 'drive_doc',
    graphNodeId: 'document:drive_doc:drive%3Afile-1%3Arev-1',
    id: 'document-drive-1',
    rawDocumentId: 'raw-drive-1',
  });
  const fixture = new InMemoryGraphFixture([
    {
      document: driveDocument,
      parsed: driveParsed({
        topics: [
          {
            metadata: { source: 'title' },
            target: 'Spec draft',
            topicType: 'keyword',
          },
        ],
      }),
      rawContentHash: 'drive-hash',
      rawDocumentId: 'raw-drive-1',
    },
  ]);

  await storeGraphRelations(fixture.storeOptions());

  assert.ok(fixture.nodes.has('topic:keyword:spec%20draft'));
  assert.ok(fixture.hasEdge(driveDocument.graphNodeId, 'MENTIONS', 'topic:keyword:spec%20draft'));
  assert.equal(fixture.nodes.get('topic:keyword:spec%20draft')?.properties.target, 'Spec draft');
});

test('storeGraphRelations materializes parsed GitHub keyword topics as mentions', async () => {
  const githubDocument = documentRecord({
    docType: 'pull_request',
    graphNodeId: 'document:pull_request:example-org%2Fpufu-sample%2Fpulls%2F202',
    id: 'document-github-pr-202',
    rawDocumentId: 'raw-github-pr-202',
    sourceId: 'example-org/pufu-sample/pulls/202',
  });
  const fixture = new InMemoryGraphFixture([
    {
      document: githubDocument,
      parsed: githubParsed({
        docType: 'pull_request',
        sourceId: 'example-org/pufu-sample/pulls/202',
        topics: [
          {
            metadata: { source: 'title' },
            target: 'Parser fixtures',
            topicType: 'keyword',
          },
        ],
      }),
      rawContentHash: 'github-hash',
      rawDocumentId: 'raw-github-pr-202',
    },
  ]);

  await storeGraphRelations(fixture.storeOptions());

  assert.ok(fixture.nodes.has('topic:keyword:parser%20fixtures'));
  assert.ok(
    fixture.hasEdge(githubDocument.graphNodeId, 'MENTIONS', 'topic:keyword:parser%20fixtures'),
  );
  assert.equal(
    fixture.nodes.get('topic:keyword:parser%20fixtures')?.properties.target,
    'Parser fixtures',
  );
});

test('storeGraphRelations shares normalized GitHub topic nodes across documents', async () => {
  const issueDocument = documentRecord({
    docType: 'issue',
    graphNodeId: 'document:issue:example-org%2Fpufu-sample%2Fissues%2F101',
    id: 'document-github-issue-101',
    rawDocumentId: 'raw-github-issue-101',
    sourceId: 'example-org/pufu-sample/issues/101',
  });
  const pullRequestDocument = documentRecord({
    docType: 'pull_request',
    graphNodeId: 'document:pull_request:example-org%2Fpufu-sample%2Fpulls%2F202',
    id: 'document-github-pr-202',
    rawDocumentId: 'raw-github-pr-202',
    sourceId: 'example-org/pufu-sample/pulls/202',
  });
  const fixture = new InMemoryGraphFixture([
    {
      document: issueDocument,
      parsed: githubParsed({
        docType: 'issue',
        sourceId: 'example-org/pufu-sample/issues/101',
        topics: [
          {
            metadata: { source: 'title' },
            target: 'Release Notes',
            topicType: 'keyword',
          },
        ],
      }),
      rawContentHash: 'hash-issue-101',
      rawDocumentId: 'raw-github-issue-101',
    },
    {
      document: pullRequestDocument,
      parsed: githubParsed({
        canonicalUri: 'https://github.com/example-org/pufu-sample/pull/202',
        docType: 'pull_request',
        relations: [
          {
            metadata: { number: 101, reason: 'github_closing_keyword' },
            target: 'example-org/pufu-sample/issues/101',
            type: 'RELATED_TO',
          },
        ],
        sourceId: 'example-org/pufu-sample/pulls/202',
        topics: [
          {
            metadata: { source: 'title' },
            target: 'release notes',
            topicType: 'keyword',
          },
        ],
      }),
      rawContentHash: 'hash-pr-202',
      rawDocumentId: 'raw-github-pr-202',
    },
  ]);
  fixture.documents.set('example-org/pufu-sample/issues/101', issueDocument);

  const result = await storeGraphRelations(fixture.storeOptions());

  const topicNodeId = 'topic:keyword:release%20notes';
  assert.equal(result.decisions.length, 2);
  assert.ok(fixture.nodes.has(topicNodeId));
  assert.ok(fixture.hasEdge(issueDocument.graphNodeId, 'MENTIONS', topicNodeId));
  assert.ok(fixture.hasEdge(pullRequestDocument.graphNodeId, 'MENTIONS', topicNodeId));
  assert.ok(
    fixture.hasEdge(pullRequestDocument.graphNodeId, 'RELATED_TO', issueDocument.graphNodeId),
  );
});

test('storeGraphRelations materializes GitHub related document edges', async () => {
  const issueDocument = documentRecord({
    docType: 'issue',
    graphNodeId: 'document:issue:example-org%2Fpufu-sample%2Fissues%2F101',
    id: 'document-github-issue-101',
    rawDocumentId: 'raw-github-issue-101',
    sourceId: 'example-org/pufu-sample/issues/101',
  });
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord({
        docType: 'pull_request',
        graphNodeId: 'document:pull_request:example-org%2Fpufu-sample%2Fpulls%2F202',
        id: 'document-github-pr-202',
        rawDocumentId: 'raw-github-pr-202',
      }),
      parsed: githubParsed({
        canonicalUri: 'https://github.com/example-org/pufu-sample/pull/202',
        docType: 'pull_request',
        relations: [
          {
            metadata: { number: 101, reason: 'github_closing_keyword' },
            target: 'example-org/pufu-sample/issues/101',
            type: 'RELATED_TO',
          },
        ],
        sourceId: 'example-org/pufu-sample/pulls/202',
      }),
      rawContentHash: 'hash-pr-202',
      rawDocumentId: 'raw-github-pr-202',
    },
  ]);
  fixture.documents.set('example-org/pufu-sample/issues/101', issueDocument);

  const result = await storeGraphRelations(fixture.storeOptions());

  const edgeKey =
    'document:pull_request:example-org%2Fpufu-sample%2Fpulls%2F202:RELATED_TO:document:issue:example-org%2Fpufu-sample%2Fissues%2F101';
  assert.equal(result.decisions[0]?.graphEdgeCount, 1);
  assert.ok(
    fixture.hasEdge(
      'document:pull_request:example-org%2Fpufu-sample%2Fpulls%2F202',
      'RELATED_TO',
      'document:issue:example-org%2Fpufu-sample%2Fissues%2F101',
    ),
  );
  assert.equal(
    fixture.edges.get(edgeKey)?.properties.relationTarget,
    'example-org/pufu-sample/issues/101',
  );
  assert.ok(fixture.nodes.has('document:issue:example-org%2Fpufu-sample%2Fissues%2F101'));
});

test('storeGraphRelations skips blank reply relation targets', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord(),
      parsed: gmailParsed({
        relations: [{ target: '   ', type: 'REPLY_TO' }],
      }),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);

  await storeGraphRelations(fixture.storeOptions());

  assert.equal([...fixture.nodes.keys()].filter((key) => key.startsWith('topic:')).length, 0);
});

test('storeGraphRelations rejects stale document graph keys before writing graph data', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord({ graphNodeId: 'document:issue:stale' }),
      parsed: githubParsed(),
      rawContentHash: 'hash-1',
      rawDocumentId: 'raw-github-1',
    },
  ]);

  const result = await storeGraphRelations(fixture.storeOptions());

  assert.equal(result.decisions[0]?.decision, 'failed');
  assert.match(result.decisions[0]?.errorMessage ?? '', /Document graph key mismatch/);
  assert.deepEqual(fixture.failureUpdates, [
    {
      errorMessage:
        'Document graph key mismatch for example-org/pufu-sample/issues/101: expected document:issue:example-org%2Fpufu-sample%2Fissues%2F101, got document:issue:stale',
      projectId: 'project-a',
      rawDocumentId: 'raw-github-1',
    },
  ]);
  assert.equal(fixture.nodes.size, 0);
  assert.equal(fixture.edges.size, 0);
});

test('storeGraphRelations continues after a failed document', async () => {
  const fixture = new InMemoryGraphFixture([
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
  fixture.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  fixture.aliases.set(
    'email:sender@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );
  fixture.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  fixture.aliases.set(
    'email:reviewer@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );

  const result = await storeGraphRelations(fixture.storeOptions());

  assert.deepEqual(
    result.decisions.map((decision) => decision.decision),
    ['failed', 'indexed'],
  );
  assert.deepEqual(
    fixture.failureUpdates.map((update) => update.rawDocumentId),
    ['raw-github-1'],
  );
  assert.deepEqual(
    fixture.statusUpdates.map((update) => update.rawDocumentId),
    ['raw-email-1'],
  );
});

test('storeGraphRelations runs each document in its target transaction boundary', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord(),
      parsed: gmailParsed(),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);
  fixture.actors.push({
    displayName: 'Sample Sender',
    graphNodeId: 'actor:email:sender%40example.test',
    id: 'actor-sender',
  });
  fixture.aliases.set(
    'email:sender@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );
  fixture.actors.push({
    displayName: 'Sample Reviewer',
    graphNodeId: 'actor:email:reviewer%40example.test',
    id: 'actor-reviewer',
  });
  fixture.aliases.set(
    'email:reviewer@example.test',
    fixture.actors.at(-1) as GraphIndexingActorRecord,
  );
  const events: string[] = [];

  const result = await storeGraphRelations({
    ...fixture.storeOptions(),
    runInTargetTransaction: async (callback) => {
      events.push('begin');
      const result = await callback({
        indexingRepository: fixture.indexingRepository(),
        mutationRepository: fixture.mutationRepository(),
      });
      events.push('commit');
      return result;
    },
  });

  assert.equal(result.decisions[0]?.decision, 'indexed');
  assert.deepEqual(events, ['begin', 'commit']);
  assert.deepEqual(fixture.statusUpdates, [
    { projectId: 'project-a', rawDocumentId: 'raw-email-1' },
  ]);
});

test('storeGraphRelations marks failure after a target transaction rolls back', async () => {
  const fixture = new InMemoryGraphFixture([
    {
      document: documentRecord(),
      parsed: gmailParsed(),
      rawContentHash: 'same-hash',
      rawDocumentId: 'raw-email-1',
    },
  ]);
  const events: string[] = [];

  const result = await storeGraphRelations({
    ...fixture.storeOptions(),
    runInTargetTransaction: async () => {
      events.push('begin');
      events.push('rollback');
      throw new Error('transactional graph failure');
    },
  });

  assert.equal(result.decisions[0]?.decision, 'failed');
  assert.deepEqual(events, ['begin', 'rollback']);
  assert.deepEqual(fixture.failureUpdates, [
    {
      errorMessage: 'transactional graph failure',
      projectId: 'project-a',
      rawDocumentId: 'raw-email-1',
    },
  ]);
});

test('storeGraphRelations keeps project slug isolation at resolver boundary', async () => {
  const fixture = new InMemoryGraphFixture([]);

  await assert.rejects(
    () =>
      storeGraphRelations({
        ...fixture.storeOptions(),
        projectSlug: 'sample-b',
      }),
    /Project not found/,
  );
});

test('storeGraphRelations collaborators stay separated without graphName', async () => {
  const fixture = new InMemoryGraphFixture([]);
  const projectResolver = fixture.projectResolver();
  const indexingRepository = fixture.indexingRepository();
  const mutationRepository = fixture.mutationRepository();

  assert.deepEqual(await projectResolver.resolveBySlug('sample-a'), {
    projectId: 'project-a',
    projectSlug: 'sample-a',
  });
  assert.equal('upsertNode' in indexingRepository, false);
  assert.equal('ensureProjectGraph' in indexingRepository, false);

  await mutationRepository.ensureProjectGraph({ projectId: 'project-a' });
  await mutationRepository.upsertNode({
    graphNodeId: 'document:email:msg-a',
    labels: ['Document'],
    projectId: 'project-a',
    properties: { documentId: 'document-a' },
  });
  assert.deepEqual(fixture.mutationProjectIds, ['project-a']);
  assert.equal(fixture.nodes.size, 1);
});

class InMemoryGraphFixture {
  readonly aliases = new Map<string, GraphIndexingActorRecord>();
  readonly actors: GraphIndexingActorRecord[] = [];
  readonly documents = new Map<string, GraphIndexingDocumentRecord>();
  readonly edges = new Map<
    string,
    {
      fromGraphNodeId: string;
      properties: Record<string, unknown>;
      projectId: string;
      relationType: GraphRelationType;
      toGraphNodeId: string;
    }
  >();
  readonly emailQuotes = new Map<string, GraphIndexingEmailQuoteInput[]>();
  readonly nodes = new Map<
    string,
    {
      graphNodeId: string;
      labels: readonly string[];
      projectId: string;
      properties: Record<string, unknown>;
    }
  >();
  readonly projectId = 'project-a';
  readonly projectSlug = 'sample-a';
  readonly sameAsDocuments: GraphIndexingDocumentRecord[] = [];
  readonly failureUpdates: Array<{
    errorMessage: string;
    projectId: string;
    rawDocumentId: string;
  }> = [];
  readonly statusUpdates: Array<{ projectId: string; rawDocumentId: string }> = [];
  readonly mutationProjectIds: string[] = [];

  constructor(private readonly targets: GraphIndexingTarget[]) {}

  projectResolver(): ProjectResolver {
    const fixture = this;
    return {
      async resolveBySlug(slug: string) {
        if (slug !== fixture.projectSlug) {
          return undefined;
        }
        return { projectId: fixture.projectId, projectSlug: fixture.projectSlug };
      },
    };
  }

  indexingRepository(): GraphIndexingRepository {
    const fixture = this;
    return {
      async findActorByAlias(input) {
        assert.equal(input.projectId, fixture.projectId);
        return fixture.aliases.get(`${input.aliasType}:${input.aliasValue}`);
      },
      async findActorByGraphNodeId(input) {
        assert.equal(input.projectId, fixture.projectId);
        return fixture.actors.find((actor) => actor.graphNodeId === input.graphNodeId);
      },
      async findDocumentsBySourceIds(input) {
        assert.equal(input.projectId, fixture.projectId);
        return input.sourceIds
          .map((sourceId) => fixture.documents.get(sourceId))
          .filter((document): document is GraphIndexingDocumentRecord => document !== undefined);
      },
      async findSameAsDocuments(input) {
        assert.equal(input.projectId, fixture.projectId);
        if (input.rawContentHash !== 'same-hash') {
          return [];
        }
        return fixture.sameAsDocuments.filter(
          (document) => document.rawDocumentId !== input.rawDocumentId,
        );
      },
      async markFailed(input) {
        fixture.failureUpdates.push(input);
      },
      async markIndexed(input) {
        fixture.statusUpdates.push(input);
      },
      async readGraphTargets(input) {
        assert.equal(input.projectId, fixture.projectId);
        return fixture.targets.slice(0, input.limit);
      },
      async replaceEmailQuotes(input) {
        assert.equal(input.projectId, fixture.projectId);
        fixture.emailQuotes.set(input.documentId, [...input.quotes]);
      },
    };
  }

  mutationRepository(): GraphMutationRepository {
    const fixture = this;
    return {
      async deleteDocumentGraphNodes(input) {
        assert.equal(input.projectId, fixture.projectId);
        return 0;
      },
      async deleteProjectGraph(input) {
        assert.equal(input.projectId, fixture.projectId);
      },
      async ensureProjectGraph(input) {
        fixture.mutationProjectIds.push(input.projectId);
      },
      async mergeActorGraphNodes(input) {
        assert.equal(input.projectId, fixture.projectId);
        return { reason: 'test skip', status: 'skipped' };
      },
      async upsertEdge(input) {
        assert.equal(input.projectId, fixture.projectId);
        fixture.edges.set(edgeKey(input), input);
      },
      async upsertNode(input) {
        assert.equal(input.projectId, fixture.projectId);
        fixture.nodes.set(input.graphNodeId, input);
      },
    };
  }

  storeOptions(limit = 10) {
    return {
      indexingRepository: this.indexingRepository(),
      limit,
      mutationRepository: this.mutationRepository(),
      projectResolver: this.projectResolver(),
      projectSlug: this.projectSlug,
    };
  }

  hasEdge(fromGraphNodeId: string, relationType: string, toGraphNodeId: string): boolean {
    return this.edges.has(`${fromGraphNodeId}:${relationType}:${toGraphNodeId}`);
  }
}

function edgeKey(input: {
  fromGraphNodeId: string;
  relationType: GraphRelationType;
  toGraphNodeId: string;
}): string {
  return `${input.fromGraphNodeId}:${input.relationType}:${input.toGraphNodeId}`;
}

function documentRecord(
  input: Partial<GraphIndexingDocumentRecord> = {},
): GraphIndexingDocumentRecord {
  return {
    docType: 'email',
    graphNodeId: 'document:email:thread-alpha%3Amsg-alpha-003',
    id: 'document-email-1',
    rawDocumentId: 'raw-email-1',
    sourceId: 'thread-alpha:msg-alpha-003',
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

function githubParsed(input: Partial<ParsedDocument> = {}): ParsedDocument {
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
    ...input,
  };
}

function webParsed(): ParsedDocument {
  return {
    actors: [
      {
        displayName: 'Sample Writer',
        domain: 'note.example.test/sample-writer',
        role: 'author',
      },
    ],
    bodyText: 'Web body',
    canonicalUri: 'https://note.example.test/sample-writer/post-1',
    docType: 'web_page',
    metadata: {},
    occurredAt: '2026-05-01T09:00:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'https://note.example.test/sample-writer/post-1',
    sourceType: 'web',
    title: 'Web article',
  };
}

function driveParsed(
  input: Partial<Pick<ParsedDocument, 'actors' | 'relations' | 'topics'>> = {},
): ParsedDocument {
  return {
    actors: input.actors ?? [],
    bodyText: 'Shared spec content.',
    canonicalUri: 'https://drive.example.test/file-1',
    docType: 'drive_doc',
    metadata: {},
    occurredAt: '2026-05-02T09:00:00.000Z',
    relations: input.relations ?? [],
    schemaVersion: 1,
    sourceId: 'drive:file-1:rev-1',
    sourceType: 'drive',
    title: 'Spec draft',
    ...(input.topics ? { topics: input.topics } : {}),
  };
}
