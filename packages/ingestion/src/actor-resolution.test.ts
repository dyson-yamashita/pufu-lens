import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ActorAliasRecord,
  type ActorRecord,
  type ActorResolutionRepository,
  type CreateActorInput,
  parseSenderAlias,
  type ResolveParsedDocumentTarget,
  resolveActors,
  type UpsertActorAliasInput,
} from './actor-resolution.js';
import type { ParsedDocument } from './ingestion-fixtures.js';

test('resolveActors merges repeated email and GitHub aliases into one actor', async () => {
  const repository = new InMemoryActorResolutionRepository([
    {
      parsed: githubParsed({
        actors: [
          { displayName: 'Sample Author', githubLogin: 'sample-author', role: 'author' },
          { displayName: 'Sample Author', githubLogin: 'SAMPLE-AUTHOR', role: 'commenter' },
        ],
      }),
      rawDocumentId: 'raw-github-1',
    },
    {
      parsed: gmailParsed(),
      rawDocumentId: 'raw-gmail-1',
    },
  ]);

  const result = await resolveActors({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  const githubActors = result.decisions[0]?.actors ?? [];
  assert.equal(githubActors[0]?.actorId, githubActors[1]?.actorId);
  assert.equal(repository.countAliases('github_login', 'sample-author'), 1);

  const gmailDecision = result.decisions[1];
  assert.ok(gmailDecision);
  const reviewerActorId = gmailDecision.actors.find(
    (actor) => actor.displayName === 'Sample Reviewer',
  )?.actorId;
  assert.equal(gmailDecision.emailQuotes[0]?.senderActorId, reviewerActorId);
  assert.equal(repository.countAliases('email', 'reviewer@example.test'), 1);
});

test('resolveActors does not merge display-name-only mentions', async () => {
  const repository = new InMemoryActorResolutionRepository([
    {
      parsed: githubParsed({
        actors: [
          { displayName: 'Alex Kim', role: 'author' },
          { displayName: 'Alex Kim', role: 'commenter' },
        ],
      }),
      rawDocumentId: 'raw-github-1',
    },
  ]);

  const result = await resolveActors({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  const actorIds = result.decisions[0]?.actors.map((actor) => actor.actorId) ?? [];
  assert.equal(new Set(actorIds).size, 2);
  assert.equal(repository.aliases.length, 0);
  assert.deepEqual(
    result.decisions[0]?.actors.map((actor) => actor.aliases[0]),
    [
      {
        aliasType: 'display_name',
        aliasValue: 'Alex Kim',
        confidence: 0.4,
        persisted: false,
        source: 'github:author',
      },
      {
        aliasType: 'display_name',
        aliasValue: 'Alex Kim',
        confidence: 0.4,
        persisted: false,
        source: 'github:commenter',
      },
    ],
  );
});

test('resolveActors preserves Gmail quote order and previous quote index', async () => {
  const repository = new InMemoryActorResolutionRepository([
    {
      parsed: gmailParsed({
        emailQuotes: [
          {
            bodyText: 'Second message',
            from: 'Sample Reviewer <reviewer@example.test>',
            messageId: 'msg-alpha-002',
            sentAt: '2026-05-05T14:50:00.000Z',
          },
          {
            bodyText: 'First message',
            from: 'Sample Sender <sender@example.test>',
            messageId: 'msg-alpha-001',
            prevMessageId: 'msg-alpha-002',
            sentAt: '2026-05-05T14:10:00.000Z',
          },
        ],
      }),
      rawDocumentId: 'raw-gmail-1',
    },
  ]);

  const result = await resolveActors({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.deepEqual(
    result.decisions[0]?.emailQuotes.map((quote) => ({
      prevQuoteIndex: quote.prevQuoteIndex,
      quoteIndex: quote.quoteIndex,
      quotedMessageId: quote.quotedMessageId,
    })),
    [
      { prevQuoteIndex: undefined, quoteIndex: 1, quotedMessageId: 'msg-alpha-002' },
      { prevQuoteIndex: 1, quoteIndex: 2, quotedMessageId: 'msg-alpha-001' },
    ],
  );
});

test('resolveActors keeps display-only quote senders distinct', async () => {
  const repository = new InMemoryActorResolutionRepository([
    {
      parsed: gmailParsed({
        actors: [{ displayName: 'Unknown Sender', role: 'sender' }],
        emailQuotes: [
          {
            bodyText: 'Display-only first quote',
            from: 'Unknown Sender',
            messageId: 'msg-alpha-002',
            sentAt: '2026-05-05T14:50:00.000Z',
          },
          {
            bodyText: 'Display-only second quote',
            from: 'Unknown Sender',
            messageId: 'msg-alpha-001',
            sentAt: '2026-05-05T14:10:00.000Z',
          },
        ],
      }),
      rawDocumentId: 'raw-gmail-1',
    },
  ]);

  const result = await resolveActors({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  const senderActorIds = [
    result.decisions[0]?.actors[0]?.actorId,
    ...(result.decisions[0]?.emailQuotes.map((quote) => quote.senderActorId) ?? []),
  ];
  assert.equal(new Set(senderActorIds).size, 3);
});

test('parseSenderAlias accepts display-only sender aliases', () => {
  assert.deepEqual(parseSenderAlias('Unknown Sender'), { displayName: 'Unknown Sender' });
});

test('resolveActors encodes graph node id components', async () => {
  const repository = new InMemoryActorResolutionRepository([
    {
      parsed: githubParsed({
        actors: [{ displayName: 'Alex Kim: Docs', role: 'author' }],
      }),
      rawDocumentId: 'raw-github-1',
    },
  ]);

  await resolveActors({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal(
    repository.actors[0]?.graphNodeId,
    'actor:unresolved:example-org%2Fpufu-sample%2Fissues%2F101:author%3A0:Alex%20Kim%3A%20Docs',
  );
});

test('resolveActors caches all strong aliases after a partial alias hit', async () => {
  const repository = new InMemoryActorResolutionRepository([
    {
      parsed: githubParsed({
        actors: [
          {
            displayName: 'Sample Hybrid',
            email: 'hybrid@example.test',
            githubLogin: 'sample-hybrid',
            role: 'author',
          },
          {
            displayName: 'Sample Hybrid',
            email: 'hybrid@example.test',
            githubLogin: 'sample-hybrid',
            role: 'commenter',
          },
        ],
      }),
      rawDocumentId: 'raw-github-1',
    },
  ]);
  const actor = await repository.createActor({
    actorType: 'person',
    displayName: 'Sample Hybrid',
    graphNodeId: 'actor:email:hybrid%40example.test',
    metadata: {},
    primaryEmail: 'hybrid@example.test',
    projectId: repository.project.id,
  });
  await repository.upsertActorAlias({
    actorId: actor.id,
    aliasType: 'email',
    aliasValue: 'hybrid@example.test',
    confidence: 1,
    projectId: repository.project.id,
    source: 'fixture',
  });

  await resolveActors({
    limit: 10,
    projectSlug: 'sample-a',
    repository,
  });

  assert.equal(repository.findAliasCalls.length, 1);
});

class InMemoryActorResolutionRepository implements ActorResolutionRepository {
  readonly actors: ActorRecord[] = [];
  readonly aliases: ActorAliasRecord[] = [];
  readonly findAliasCalls: Array<{ aliasType: ActorAliasRecord['aliasType']; aliasValue: string }> =
    [];
  readonly project = { id: 'project-1', slug: 'sample-a' };

  constructor(private readonly targets: ResolveParsedDocumentTarget[]) {}

  async lookupProjectBySlug(slug: string): Promise<{ id: string; slug: string } | undefined> {
    return slug === this.project.slug ? this.project : undefined;
  }

  async readParsedDocuments(input: {
    limit: number;
    projectId: string;
  }): Promise<ResolveParsedDocumentTarget[]> {
    if (input.projectId !== this.project.id) {
      return [];
    }
    return this.targets.slice(0, input.limit);
  }

  async findActorByAlias(input: {
    aliasType: ActorAliasRecord['aliasType'];
    aliasValue: string;
    projectId: string;
  }): Promise<ActorRecord | undefined> {
    this.findAliasCalls.push({ aliasType: input.aliasType, aliasValue: input.aliasValue });
    const alias = this.aliases.find(
      (candidate) =>
        candidate.projectId === input.projectId &&
        candidate.aliasType === input.aliasType &&
        candidate.aliasValue === input.aliasValue,
    );
    return alias === undefined
      ? undefined
      : this.actors.find((actor) => actor.id === alias.actorId);
  }

  async createActor(input: CreateActorInput): Promise<ActorRecord> {
    const existing = this.actors.find(
      (actor) => actor.projectId === input.projectId && actor.graphNodeId === input.graphNodeId,
    );
    if (existing) {
      return existing;
    }

    const actor = {
      displayName: input.displayName,
      graphNodeId: input.graphNodeId,
      id: `actor-${this.actors.length + 1}`,
      primaryEmail: input.primaryEmail,
      primaryLogin: input.primaryLogin,
      projectId: input.projectId,
    };
    this.actors.push(actor);
    return actor;
  }

  async upsertActorAlias(input: UpsertActorAliasInput): Promise<ActorAliasRecord> {
    const existing = this.aliases.find(
      (alias) =>
        alias.projectId === input.projectId &&
        alias.aliasType === input.aliasType &&
        alias.aliasValue === input.aliasValue,
    );
    if (existing) {
      existing.actorId = input.actorId;
      existing.confidence = Math.max(existing.confidence, input.confidence);
      existing.source = [...new Set([...existing.source.split(','), input.source])]
        .sort()
        .join(',');
      return existing;
    }

    const alias = { ...input };
    this.aliases.push(alias);
    return alias;
  }

  countAliases(aliasType: ActorAliasRecord['aliasType'], aliasValue: string): number {
    return this.aliases.filter(
      (alias) => alias.aliasType === aliasType && alias.aliasValue === aliasValue,
    ).length;
  }
}

function githubParsed(input: Partial<Pick<ParsedDocument, 'actors'>> = {}): ParsedDocument {
  return {
    actors: input.actors ?? [
      { displayName: 'Sample Author', githubLogin: 'sample-author', role: 'author' },
    ],
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

function gmailParsed(
  input: Partial<Pick<ParsedDocument, 'actors' | 'emailQuotes'>> = {},
): ParsedDocument {
  return {
    actors: input.actors ?? [
      {
        displayName: 'Sample Sender',
        email: 'sender@example.test',
        role: 'sender',
      },
      {
        displayName: 'Sample Reviewer',
        email: 'reviewer@example.test',
        role: 'commenter',
      },
    ],
    bodyText: 'Latest update.',
    canonicalUri: 'gmail://thread-alpha/msg-alpha-003',
    docType: 'email',
    emailQuotes: input.emailQuotes ?? [
      {
        bodyText: 'Please keep quoted text out of the primary document body.',
        from: 'Sample Reviewer <reviewer@example.test>',
        messageId: 'msg-alpha-002',
        sentAt: '2026-05-05T14:50:00.000Z',
      },
    ],
    metadata: {
      threadId: 'thread-alpha',
      toCount: 1,
    },
    occurredAt: '2026-05-05T15:20:00.000Z',
    relations: [],
    schemaVersion: 1,
    sourceId: 'thread-alpha:msg-alpha-003',
    sourceType: 'gmail',
    title: 'Fixture ingestion review',
  };
}
