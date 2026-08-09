import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dedupeRecipients,
  reconstructReportDeliveryRecipients,
  wasFollowAcceptedAt,
} from './report-delivery.ts';

const publicationAt = new Date('2026-01-15T12:00:00.000Z');

test('wasFollowAcceptedAt uses accepted_at and preserves audience after undo', () => {
  const acceptedAt = new Date('2026-01-01T00:00:00.000Z');
  const undoneAt = new Date('2026-02-01T00:00:00.000Z');
  assert.equal(wasFollowAcceptedAt({ acceptedAt, undoneAt, occurredAt: publicationAt }), true);
  assert.equal(
    wasFollowAcceptedAt({
      acceptedAt,
      undoneAt,
      occurredAt: new Date('2026-03-01T00:00:00.000Z'),
    }),
    false,
  );
});

test('reconstructReportDeliveryRecipients prefers Create for shared remote Actor', () => {
  const recipients = reconstructReportDeliveryRecipients({
    publicationOccurredAt: publicationAt,
    projectActorId: 'project-actor',
    aggregateActorId: 'aggregate-actor',
    createActivityUri: 'https://lens.test/activitypub/activities/create/report-1',
    announceActivityUri: 'https://lens.test/activitypub/activities/announce/report-1',
    objectUri: 'https://lens.test/activitypub/reports/report-1',
    projectFollowers: [
      {
        remoteActorUri: 'https://remote.example/users/alice',
        remoteInboxUri: 'https://remote.example/users/alice/inbox',
        remoteSharedInboxUri: null,
        acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
        undoneAt: null,
      },
    ],
    aggregateFollowers: [
      {
        remoteActorUri: 'https://remote.example/users/alice',
        remoteInboxUri: 'https://remote.example/users/alice/inbox',
        remoteSharedInboxUri: null,
        acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
        undoneAt: null,
      },
      {
        remoteActorUri: 'https://remote.example/users/bob',
        remoteInboxUri: 'https://remote.example/users/bob/inbox',
        remoteSharedInboxUri: 'https://remote.example/inbox',
        acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
        undoneAt: null,
      },
    ],
  });

  assert.equal(recipients.length, 2);
  assert.equal(recipients[0]?.activityType, 'Create');
  assert.equal(recipients[0]?.sharedInbox, false);
  assert.equal(recipients[1]?.activityType, 'Announce');
  assert.equal(recipients[1]?.sharedInbox, true);
});

test('dedupeRecipients keeps Create and Announce on the same shared inbox', () => {
  const recipients = dedupeRecipients([
    {
      remoteActorUri: 'https://remote.example/users/alice',
      inboxUri: 'https://remote.example/inbox',
      sharedInbox: true,
      activityType: 'Create',
      activityUri: 'https://lens.test/activitypub/activities/create/report-1',
      orderingKey: 'https://lens.test/activitypub/reports/report-1',
    },
    {
      remoteActorUri: 'https://remote.example/users/bob',
      inboxUri: 'https://remote.example/inbox',
      sharedInbox: true,
      activityType: 'Announce',
      activityUri: 'https://lens.test/activitypub/activities/announce/report-1',
      orderingKey: 'https://lens.test/activitypub/reports/report-1',
    },
  ]);
  assert.equal(recipients.length, 2);
});
