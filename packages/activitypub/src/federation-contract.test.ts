import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryKvStore } from '@fedify/fedify';
import { createProductionActivityPubFederation } from './federation.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

const canonicalOrigin = 'https://lens.test';
const canonicalHost = 'lens.test';
const encryptionKey = Buffer.alloc(32, 9);
const projectId = '20000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const reportId = '30000000-0000-0000-0000-000000000001';

function createQueue() {
  return {
    nativeRetrial: true as const,
    async enqueue() {
      return undefined;
    },
    async listen() {
      await new Promise<void>(() => undefined);
    },
  };
}

async function assertRemotelyVisibleActorContract(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  uri: ReturnType<typeof buildActivityPubUriContract>,
  preferredUsername: string,
) {
  const headers = { Accept: 'application/activity+json' };
  const webfingerResponse = await fetch(
    `${canonicalOrigin}/.well-known/webfinger?resource=${uri.webfingerAcct(preferredUsername)}`,
  );
  assert.equal(webfingerResponse.status, 200);
  const webfinger = (await webfingerResponse.json()) as {
    subject: string;
    links: Array<{ rel: string; href?: string }>;
  };
  assert.equal(webfinger.subject, uri.webfingerAcct(preferredUsername));
  const selfLink = webfinger.links.find((link) => link.rel === 'self');
  assert.equal(selfLink?.href, uri.actorUrl(preferredUsername));

  const actorResponse = await fetch(uri.actorUrl(preferredUsername), { headers });
  assert.equal(actorResponse.status, 200);
  const actor = (await actorResponse.json()) as Record<string, string>;
  assert.equal(actor.id, uri.actorUrl(preferredUsername));
  assert.equal(actor.preferredUsername, preferredUsername);
  assert.equal(actor.inbox, uri.personalInboxUrl(preferredUsername));
  assert.equal(actor.outbox, uri.actorOutboxUrl(preferredUsername));
  assert.equal(actor.followers, uri.actorFollowersUrl(preferredUsername));
  assert.equal(actor.following, uri.actorFollowingUrl(preferredUsername));

  const keyResponse = await fetch(uri.actorKeyId(preferredUsername), { headers });
  assert.equal(keyResponse.status, 200);
  const key = (await keyResponse.json()) as { id: string };
  assert.ok(
    key.id === uri.actorKeyId(preferredUsername) || key.id === uri.actorUrl(preferredUsername),
    `unexpected public key id: ${key.id}`,
  );
}

test('production federation resolves aggregate and project actors with endpoint contracts', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    projectName: 'Sample Project',
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });

  const fetch = (input: string, init?: RequestInit) =>
    federation.fetch(new Request(input, init), { contextData: undefined });
  const uri = buildActivityPubUriContract(canonicalOrigin);

  await assertRemotelyVisibleActorContract(fetch, uri, 'all');
  await assertRemotelyVisibleActorContract(fetch, uri, projectSlug);

  const headers = { Accept: 'application/activity+json' };
  for (const collectionUrl of [
    uri.actorFollowersUrl(projectSlug),
    uri.actorFollowingUrl(projectSlug),
    uri.actorOutboxUrl(projectSlug),
  ]) {
    assert.equal((await fetch(collectionUrl, { headers })).status, 200);
  }
});

test('production federation returns 404 for disabled, private, and missing actors across all endpoints', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: false,
  });
  const privateProjectId = '20000000-0000-0000-0000-000000000002';
  repository.seedProject({
    id: privateProjectId,
    slug: 'private-project',
    name: 'Private Project',
    visibility: 'private',
  });
  await repository.seedProjectActor({
    projectId: privateProjectId,
    projectSlug: 'private-project',
    preferredUsername: 'private-project',
    visibility: 'private',
    enabled: true,
  });
  repository.seedPublicReport({
    reportId,
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    title: 'Quarterly Update',
    summary: 'Summary',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const fetch = (input: string, init?: RequestInit) =>
    federation.fetch(new Request(input, init), { contextData: undefined });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const headers = { Accept: 'application/activity+json' };

  for (const username of [projectSlug, 'private-project', 'missing-project']) {
    const statuses = await Promise.all([
      fetch(
        `${canonicalOrigin}/.well-known/webfinger?resource=acct:${username}@${canonicalHost}`,
      ).then((r) => r.status),
      fetch(uri.actorUrl(username), { headers }).then((r) => r.status),
      fetch(uri.actorFollowersUrl(username), { headers }).then((r) => r.status),
      fetch(uri.actorFollowingUrl(username), { headers }).then((r) => r.status),
      fetch(uri.actorOutboxUrl(username), { headers }).then((r) => r.status),
      fetch(uri.reportArticleUrl(reportId), { headers }).then((r) => r.status),
    ]);
    assert.deepEqual(
      statuses,
      [404, 404, 404, 404, 404, 404],
      `expected hidden actor ${username} to 404 everywhere`,
    );
  }
});

test('production federation does not emit Article when singleton config is note', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  repository.setInstanceObjectRepresentation('note');
  repository.seedPublicReport({
    reportId,
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    title: 'Quarterly Update',
    summary: 'Summary',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const response = await federation.fetch(
    new Request(uri.reportArticleUrl(reportId), {
      headers: { Accept: 'application/activity+json' },
    }),
    { contextData: undefined },
  );
  assert.equal(response.status, 404);
});

test('production federation resolves public report articles when config is article', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  repository.seedPublicReport({
    reportId,
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    title: 'Quarterly Update',
    summary: 'A concise public summary.',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const response = await federation.fetch(
    new Request(uri.reportArticleUrl(reportId), {
      headers: { Accept: 'application/activity+json' },
    }),
    { contextData: undefined },
  );
  assert.equal(response.status, 200);
});
