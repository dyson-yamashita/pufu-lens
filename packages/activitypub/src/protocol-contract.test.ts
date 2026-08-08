import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITYPUB_URI_CONTRACT,
  createActivityPubProtocolFixture,
  resolveStableCreateActivityId,
} from './protocol.ts';

const canonicalHost = 'lens.test';
const canonicalOrigin = `https://${canonicalHost}`;
const preferredUsername = 'pufu';
const reportId = 'report-1';
const projectSlug = 'sample-project';

test('ACTIVITYPUB_URI_CONTRACT fixes canonical identifiers', () => {
  assert.equal(ACTIVITYPUB_URI_CONTRACT.canonicalHost, canonicalHost);
  assert.equal(ACTIVITYPUB_URI_CONTRACT.canonicalOrigin, canonicalOrigin);
  assert.equal(
    ACTIVITYPUB_URI_CONTRACT.webfingerAcct(preferredUsername),
    `acct:${preferredUsername}@${canonicalHost}`,
  );
  assert.equal(
    ACTIVITYPUB_URI_CONTRACT.actorUrl(preferredUsername),
    `${canonicalOrigin}/activitypub/actors/${preferredUsername}`,
  );
  assert.equal(
    ACTIVITYPUB_URI_CONTRACT.personalInboxUrl(preferredUsername),
    `${canonicalOrigin}/activitypub/actors/${preferredUsername}/inbox`,
  );
  assert.equal(ACTIVITYPUB_URI_CONTRACT.sharedInboxUrl, `${canonicalOrigin}/activitypub/inbox`);
  assert.equal(
    ACTIVITYPUB_URI_CONTRACT.reportArticleUrl(reportId),
    `${canonicalOrigin}/activitypub/reports/${reportId}`,
  );
  assert.equal(
    ACTIVITYPUB_URI_CONTRACT.publicReportUrl(projectSlug, reportId),
    `${canonicalOrigin}/reports/public/${projectSlug}/${reportId}`,
  );
});

test('createActivityPubProtocolFixture resolves WebFinger to Service Actor and Article', async () => {
  const fixture = await createActivityPubProtocolFixture({
    canonicalOrigin,
    preferredUsername,
    report: {
      reportId,
      projectSlug,
      title: 'Quarterly Update',
      summary: 'A concise public summary.',
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  });

  const webfingerResponse = await fixture.federation.fetch(
    `${canonicalOrigin}/.well-known/webfinger?resource=acct:${preferredUsername}@${canonicalHost}`,
  );
  assert.equal(webfingerResponse.status, 200);
  const webfinger = (await webfingerResponse.json()) as {
    subject: string;
    links: Array<{ rel: string; href: string }>;
  };
  assert.equal(webfinger.subject, `acct:${preferredUsername}@${canonicalHost}`);
  const actorLink = webfinger.links.find((link) => link.rel === 'self');
  if (!actorLink) {
    assert.fail('expected self link in webfinger response');
  }
  assert.equal(actorLink.href, `${canonicalOrigin}/activitypub/actors/${preferredUsername}`);

  const actorResponse = await fixture.federation.fetch(actorLink.href, {
    headers: { Accept: 'application/activity+json' },
  });
  assert.equal(actorResponse.status, 200);
  assert.match(actorResponse.headers.get('content-type') ?? '', /activity\+json/);
  const actor = (await actorResponse.json()) as {
    type: string;
    id: string;
    inbox: string;
    outbox: string;
  };
  assert.equal(actor.type, 'Service');
  assert.equal(actor.id, `${canonicalOrigin}/activitypub/actors/${preferredUsername}`);
  assert.equal(actor.inbox, `${canonicalOrigin}/activitypub/actors/${preferredUsername}/inbox`);
  assert.equal(actor.outbox, `${canonicalOrigin}/activitypub/actors/${preferredUsername}/outbox`);

  const articleUrl = `${canonicalOrigin}/activitypub/reports/${reportId}`;
  const articleResponse = await fixture.federation.fetch(articleUrl, {
    headers: { Accept: 'application/activity+json' },
  });
  assert.equal(articleResponse.status, 200);
  assert.match(articleResponse.headers.get('content-type') ?? '', /activity\+json/);
  const article = (await articleResponse.json()) as {
    type: string;
    id: string;
    name: string;
    summary: string;
    url: string;
  };
  assert.equal(article.type, 'Article');
  assert.equal(article.id, articleUrl);
  assert.equal(article.name, 'Quarterly Update');
  assert.equal(article.summary, 'A concise public summary.');
  assert.equal(article.url, `${canonicalOrigin}/reports/public/${projectSlug}/${reportId}`);

  const stableActivityId = resolveStableCreateActivityId({
    canonicalOrigin,
    reportId,
    preferredUsername,
  });
  assert.equal(stableActivityId, `${canonicalOrigin}/activitypub/activities/create/${reportId}`);
});

test('resolveStableCreateActivityId normalizes canonical origin before building activity ID', () => {
  assert.equal(
    resolveStableCreateActivityId({
      canonicalOrigin: 'https://LENS.TEST:443/',
      reportId,
      preferredUsername,
    }),
    `${canonicalOrigin}/activitypub/activities/create/${reportId}`,
  );
});

test('createActivityPubProtocolFixture rejects HTTP localhost by default', async () => {
  await assert.rejects(
    () =>
      createActivityPubProtocolFixture({
        canonicalOrigin: 'http://localhost:3000/',
        preferredUsername,
        report: {
          reportId,
          projectSlug,
          title: 'Quarterly Update',
          summary: 'A concise public summary.',
          publishedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      }),
    /HTTPS/i,
  );
});

test('createActivityPubProtocolFixture accepts HTTP localhost only with explicit allowHttpLocalhost', async () => {
  const fixture = await createActivityPubProtocolFixture({
    canonicalOrigin: 'http://localhost:3000/',
    allowHttpLocalhost: true,
    preferredUsername,
    report: {
      reportId,
      projectSlug,
      title: 'Quarterly Update',
      summary: 'A concise public summary.',
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  });

  assert.equal(fixture.canonicalOrigin, 'http://localhost:3000');
});

test('createActivityPubProtocolFixture exposes personal and shared inbox routes that reject unsigned activities', async () => {
  const fixture = await createActivityPubProtocolFixture({
    canonicalOrigin,
    preferredUsername,
    report: {
      reportId,
      projectSlug,
      title: 'Quarterly Update',
      summary: 'A concise public summary.',
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  });

  const personalInboxResponse = await fixture.federation.fetch(
    `${canonicalOrigin}/activitypub/actors/${preferredUsername}/inbox`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/activity+json',
      },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Follow',
        actor: 'https://remote.example/users/alice',
        object: `${canonicalOrigin}/activitypub/actors/${preferredUsername}`,
      }),
    },
  );
  assert.equal(
    personalInboxResponse.status,
    401,
    `personal inbox must reject unsigned POST, got ${personalInboxResponse.status}`,
  );

  const sharedInboxResponse = await fixture.federation.fetch(
    `${canonicalOrigin}/activitypub/inbox`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/activity+json',
      },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Follow',
        actor: 'https://remote.example/users/alice',
        object: `${canonicalOrigin}/activitypub/actors/${preferredUsername}`,
      }),
    },
  );
  assert.equal(
    sharedInboxResponse.status,
    401,
    `shared inbox must reject unsigned POST, got ${sharedInboxResponse.status}`,
  );
});
