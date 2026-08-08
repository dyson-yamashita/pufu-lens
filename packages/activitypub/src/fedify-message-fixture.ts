import { randomUUID } from 'node:crypto';

/**
 * Pinned Fedify 2.3.4 outbox `Message` shape used by Step 1 contract tests.
 * This is test fixture code only and is not part of the production package surface.
 */
export type FedifyOutboxMessageFixture = {
  type: 'outbox';
  id: ReturnType<typeof randomUUID>;
  baseUrl: string;
  keys: ReadonlyArray<{
    keyId: string;
    privateKey: JsonWebKey;
  }>;
  activity: unknown;
  activityId?: string;
  activityType: string;
  inbox: string;
  sharedInbox: boolean;
  actorIds?: readonly string[];
  started: string;
  attempt: number;
  headers: Readonly<Record<string, string>>;
  orderingKey?: string;
  traceContext: Readonly<Record<string, string>>;
};

export type FedifyFanoutMessageFixture = {
  type: 'fanout';
  id: ReturnType<typeof randomUUID>;
  baseUrl: string;
  keys: ReadonlyArray<{
    keyId: string;
    privateKey: JsonWebKey;
  }>;
  inboxes: Readonly<Record<string, { actorIds: readonly string[]; sharedInbox: boolean }>>;
  activity: unknown;
  activityId?: string;
  activityType: string;
  started: string;
  attempt: number;
  headers: Readonly<Record<string, string>>;
  orderingKey?: string;
  traceContext: Readonly<Record<string, string>>;
};

export type FedifyInboxMessageFixture = {
  type: 'inbox';
  id: ReturnType<typeof randomUUID>;
  baseUrl: string;
  activity: unknown;
  started: string;
  attempt: number;
  identifier: string | null;
  traceContext: Readonly<Record<string, string>>;
};

export type CreateFedifyOutboxMessageFixtureInput = {
  baseUrl: string;
  inbox: string;
  activityId: string;
  orderingKey: string;
  keys: ReadonlyArray<{
    keyId: string;
    privateKey: JsonWebKey;
  }>;
  reportId?: string;
  projectSlug?: string;
  actorPath?: string;
  sharedInbox?: boolean;
};

export function createFedifyOutboxMessageFixture(
  input: CreateFedifyOutboxMessageFixtureInput,
): FedifyOutboxMessageFixture {
  const reportId = input.reportId ?? 'report-1';
  const projectSlug = input.projectSlug ?? 'sample-project';
  const actorPath = input.actorPath ?? 'pufu';
  const actorId = `${input.baseUrl}/activitypub/actors/${actorPath}`;

  return {
    type: 'outbox',
    id: randomUUID(),
    baseUrl: input.baseUrl,
    keys: input.keys,
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: input.activityId,
      type: 'Create',
      actor: actorId,
      object: {
        type: 'Article',
        id: `${input.baseUrl}/activitypub/reports/${reportId}`,
        attributedTo: actorId,
        name: 'Quarterly Update',
        summary: 'A concise public summary.',
        url: `${input.baseUrl}/reports/public/${projectSlug}/${reportId}`,
      },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
    activityId: input.activityId,
    activityType: 'https://www.w3.org/ns/activitystreams#Create',
    inbox: input.inbox,
    sharedInbox: input.sharedInbox ?? false,
    actorIds: [actorId],
    started: '2026-08-01T00:00:00.000Z',
    attempt: 0,
    headers: {},
    orderingKey: input.orderingKey,
    traceContext: {},
  };
}

export function createFedifyFanoutMessageFixture(input: {
  baseUrl: string;
  activityId: string;
  keys: ReadonlyArray<{
    keyId: string;
    privateKey: JsonWebKey;
  }>;
  inbox: string;
}): FedifyFanoutMessageFixture {
  return {
    type: 'fanout',
    id: randomUUID(),
    baseUrl: input.baseUrl,
    keys: input.keys,
    inboxes: {
      [input.inbox]: {
        actorIds: [`${input.baseUrl}/activitypub/actors/pufu`],
        sharedInbox: false,
      },
    },
    activity: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: input.activityId,
      type: 'Create',
      actor: `${input.baseUrl}/activitypub/actors/pufu`,
      object: {
        type: 'Article',
        id: `${input.baseUrl}/activitypub/reports/report-1`,
      },
    },
    activityId: input.activityId,
    activityType: 'https://www.w3.org/ns/activitystreams#Create',
    started: '2026-08-01T00:00:00.000Z',
    attempt: 0,
    headers: {},
    orderingKey: `${input.baseUrl}/activitypub/reports/report-1`,
    traceContext: {},
  };
}

export function createFedifyInboxMessageFixture(input: {
  baseUrl: string;
  activity: unknown;
}): FedifyInboxMessageFixture {
  return {
    type: 'inbox',
    id: randomUUID(),
    baseUrl: input.baseUrl,
    activity: input.activity,
    started: '2026-08-01T00:00:00.000Z',
    attempt: 0,
    identifier: 'pufu',
    traceContext: {},
  };
}
