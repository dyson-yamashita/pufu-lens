import { generateCryptoKeyPair, signRequest, verifyRequestDetailed } from '@fedify/fedify';
import type { DocumentLoader } from '@fedify/vocab-runtime';
import { exportSpki } from '@fedify/vocab-runtime';
import { assertActivityPubHermeticE2eRuntime } from '../test-runtime-guard.ts';
import { buildActivityPubUriContract } from '../uri-contract.ts';
import {
  detectDigestKind,
  type ProtocolTraceCollector,
  readActivityIdFromJson,
  readActivityTypeFromJson,
} from './protocol-trace.ts';

const MASTODON_ORIGIN = 'https://mastodon.test';
const MASTODON_HOST = 'mastodon.test';

export type MastodonTimelineItem = {
  readonly title: string;
  readonly summary: string;
  readonly reportUrl: string;
  readonly activityType: 'Create' | 'Announce';
  readonly activityId: string;
};

type MastodonActorFixture = {
  readonly username: string;
  readonly actorUri: string;
  readonly inboxUri: string;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly publicKeyPem: string;
};

/** Mastodon v4.6.5-compatible remote fixture for hermetic ActivityPub E2E. */
export class MastodonHermeticFixture {
  readonly origin = MASTODON_ORIGIN;
  readonly sharedInboxUri = `${MASTODON_ORIGIN}/inbox`;
  readonly #alice: MastodonActorFixture;
  readonly #bob: MastodonActorFixture;
  readonly #accepts: Array<{ readonly actor: string; readonly followActivityUri: string }> = [];
  readonly #timeline: MastodonTimelineItem[] = [];
  readonly #receivedActivityTypes: string[] = [];
  readonly #trace: ProtocolTraceCollector;
  readonly #documentLoader: DocumentLoader;

  private constructor(input: {
    alice: MastodonActorFixture;
    bob: MastodonActorFixture;
    trace: ProtocolTraceCollector;
    documentLoader: DocumentLoader;
  }) {
    this.#alice = input.alice;
    this.#bob = input.bob;
    this.#trace = input.trace;
    this.#documentLoader = input.documentLoader;
  }

  static async create(
    trace: ProtocolTraceCollector,
    documentLoader: DocumentLoader,
  ): Promise<MastodonHermeticFixture> {
    assertActivityPubHermeticE2eRuntime();
    const alice = await createActorFixture('alice');
    const bob = await createActorFixture('bob');
    return new MastodonHermeticFixture({ alice, bob, trace, documentLoader });
  }

  get aliceActorUri(): string {
    return this.#alice.actorUri;
  }

  get bobActorUri(): string {
    return this.#bob.actorUri;
  }

  get recordedAccepts(): readonly { readonly actor: string; readonly followActivityUri: string }[] {
    return this.#accepts;
  }

  get timeline(): readonly MastodonTimelineItem[] {
    return this.#timeline;
  }

  get receivedActivityTypes(): readonly string[] {
    return this.#receivedActivityTypes;
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/webfinger') {
      return this.#handleWebFinger(url);
    }
    if (url.pathname === '/inbox' && request.method === 'POST') {
      return this.#handleSharedInbox(request);
    }
    const actorMatch = url.pathname.match(/^\/users\/([^/]+)$/);
    if (actorMatch && request.method === 'GET') {
      return this.#handleActor(actorMatch[1] ?? '');
    }
    const inboxMatch = url.pathname.match(/^\/users\/([^/]+)\/inbox$/);
    if (inboxMatch && request.method === 'POST') {
      return this.#handleActorInbox(request, inboxMatch[1] ?? '');
    }
    return new Response('not found', { status: 404 });
  }

  async signedFollowToRemote(input: {
    actor: 'alice' | 'bob';
    targetInboxUri: string;
    targetActorUri: string;
    followActivityUri: string;
  }): Promise<Request> {
    const actor = input.actor === 'alice' ? this.#alice : this.#bob;
    const body = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Follow',
      id: input.followActivityUri,
      actor: actor.actorUri,
      object: input.targetActorUri,
    });
    const request = new Request(input.targetInboxUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/activity+json',
        host: new URL(input.targetInboxUri).host,
        date: new Date().toUTCString(),
      },
      body,
    });
    return signRequest(request, actor.privateKey, new URL(actor.keyId), {
      spec: 'draft-cavage-http-signatures-12',
    });
  }

  async signedUndo(input: {
    actor: 'alice' | 'bob';
    targetInboxUri: string;
    targetActorUri: string;
    followActivityUri: string;
    undoActivityUri: string;
  }): Promise<Request> {
    const actor = input.actor === 'alice' ? this.#alice : this.#bob;
    const body = JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Undo',
      id: input.undoActivityUri,
      actor: actor.actorUri,
      object: {
        type: 'Follow',
        id: input.followActivityUri,
        actor: actor.actorUri,
        object: input.targetActorUri,
      },
    });
    const request = new Request(input.targetInboxUri, {
      method: 'POST',
      headers: {
        'content-type': 'application/activity+json',
        host: new URL(input.targetInboxUri).host,
        date: new Date().toUTCString(),
      },
      body,
    });
    return signRequest(request, actor.privateKey, new URL(actor.keyId), {
      spec: 'draft-cavage-http-signatures-12',
    });
  }

  async #handleWebFinger(url: URL): Promise<Response> {
    const resource = url.searchParams.get('resource');
    const match = resource?.match(/^acct:([^@]+)@mastodon\.test$/);
    if (!match) {
      return new Response('not found', { status: 404 });
    }
    const username = match[1] ?? '';
    const actor = this.#resolveActor(username);
    if (!actor) {
      return new Response('not found', { status: 404 });
    }
    return jsonResponse(
      {
        subject: `acct:${username}@${MASTODON_HOST}`,
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: actor.actorUri,
          },
        ],
      },
      'application/jrd+json',
    );
  }

  async #handleActor(username: string): Promise<Response> {
    const actor = this.#resolveActor(username);
    if (!actor) {
      return new Response('not found', { status: 404 });
    }
    return jsonResponse(
      {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: actor.actorUri,
        type: 'Person',
        preferredUsername: username,
        inbox: actor.inboxUri,
        outbox: `${actor.actorUri}/outbox`,
        publicKey: {
          id: actor.keyId,
          owner: actor.actorUri,
          publicKeyPem: actor.publicKeyPem,
        },
        endpoints: {
          sharedInbox: this.sharedInboxUri,
        },
      },
      'application/activity+json',
    );
  }

  async #handleActorInbox(request: Request, username: string): Promise<Response> {
    const actor = this.#resolveActor(username);
    if (!actor) {
      return new Response('not found', { status: 404 });
    }
    return this.#handleSignedInbox(request, actor);
  }

  async #handleSharedInbox(request: Request): Promise<Response> {
    return this.#handleSignedInbox(request, null);
  }

  async #handleSignedInbox(
    request: Request,
    _recipient: MastodonActorFixture | null,
  ): Promise<Response> {
    const bodyText = await request.clone().text();
    const verification = await verifyRequestDetailed(request, {
      documentLoader: this.#documentLoader,
    });
    const signatureVerified = verification.verified;
    const keyOwnerUri = verification.verified ? verification.key.ownerId?.href : undefined;
    const activityType = readActivityTypeFromJson(bodyText);
    const activityId = readActivityIdFromJson(bodyText);
    const audienceUri = readAudienceUri(bodyText);
    const activityActorUri = readActivityActorUri(bodyText);
    const digestKind = detectDigestKind(request.headers);
    const publicAudience = hasPublicAudience(bodyText);
    const actorKeyMatches = Boolean(
      keyOwnerUri && activityActorUri && keyOwnerUri === activityActorUri,
    );
    const inboxAuthenticated = signatureVerified && digestKind !== 'none' && actorKeyMatches;
    const audienceAccepted =
      activityType !== 'Create' && activityType !== 'Announce' ? true : publicAudience;

    this.#trace.record({
      method: request.method,
      host: MASTODON_HOST,
      path: new URL(request.url).pathname,
      status: !inboxAuthenticated ? 401 : audienceAccepted ? 202 : 403,
      activityType,
      activityId,
      signed: true,
      digestKind,
      signatureVerified,
      keyOwnerUri,
      audienceUri,
    });

    if (!inboxAuthenticated) {
      return new Response('unauthorized', { status: 401 });
    }
    if (activityType === 'Accept') {
      const parsed = JSON.parse(bodyText) as {
        object?: { id?: string };
      };
      if (parsed.object?.id) {
        this.#accepts.push({
          actor: keyOwnerUri ?? '',
          followActivityUri: parsed.object.id,
        });
      }
      return new Response(null, { status: 202 });
    }

    if (activityType === 'Create' || activityType === 'Announce') {
      if (!publicAudience) {
        return new Response('forbidden audience', { status: 403 });
      }
      this.#receivedActivityTypes.push(activityType);
      const item = await normalizeMastodonTimelineItem(
        bodyText,
        activityType,
        activityId ?? '',
        this.#documentLoader,
      );
      if (item) {
        const existing = this.#timeline.find((entry) => entry.activityId === item.activityId);
        if (!existing) {
          this.#timeline.push(item);
        } else if (activityType === 'Create' && existing.activityType === 'Announce') {
          const index = this.#timeline.indexOf(existing);
          this.#timeline[index] = item;
        }
      }
      return new Response(null, { status: 202 });
    }

    return new Response(null, { status: 202 });
  }

  #resolveActor(username: string): MastodonActorFixture | null {
    if (username === 'alice') {
      return this.#alice;
    }
    if (username === 'bob') {
      return this.#bob;
    }
    return null;
  }
}

/** Normalizes inbound Article activities to Mastodon v4.6.5 timeline projection fields. */
export async function normalizeMastodonTimelineItem(
  bodyText: string,
  activityType: 'Create' | 'Announce',
  activityId: string,
  documentLoader?: DocumentLoader,
): Promise<MastodonTimelineItem | null> {
  const parsed = JSON.parse(bodyText) as {
    object?: Record<string, unknown> | string;
  };
  let object = typeof parsed.object === 'string' ? null : (parsed.object ?? null);
  if (!object && typeof parsed.object === 'string' && documentLoader) {
    const remote = await documentLoader(parsed.object);
    object = isRecord(remote.document) ? remote.document : null;
  }
  if (!object) {
    return null;
  }
  const title = typeof object.name === 'string' ? object.name : '';
  const summary =
    typeof object.summary === 'string'
      ? object.summary
      : typeof object.content === 'string'
        ? object.content
        : '';
  const reportUrl =
    typeof object.url === 'string' ? object.url : typeof object.id === 'string' ? object.id : '';
  if (!title || !summary || !reportUrl) {
    return null;
  }
  return { title, summary, reportUrl, activityType, activityId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createActorFixture(username: string): Promise<MastodonActorFixture> {
  const keyPair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
  const actorUri = `${MASTODON_ORIGIN}/users/${username}`;
  return {
    username,
    actorUri,
    inboxUri: `${actorUri}/inbox`,
    keyId: `${actorUri}#main-key`,
    privateKey: keyPair.privateKey,
    publicKeyPem: await exportSpki(keyPair.publicKey),
  };
}

function jsonResponse(body: unknown, contentType: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

function readAudienceUri(bodyText: string): string | undefined {
  return readAllAudienceUris(bodyText)[0];
}

function hasPublicAudience(bodyText: string): boolean {
  return readAllAudienceUris(bodyText).includes('https://www.w3.org/ns/activitystreams#Public');
}

function readAllAudienceUris(bodyText: string): string[] {
  try {
    const parsed = JSON.parse(bodyText) as { to?: unknown; cc?: unknown };
    return [
      ...(Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []),
      ...(Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : []),
    ].filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function readActivityActorUri(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { actor?: unknown };
    return typeof parsed.actor === 'string' ? parsed.actor : undefined;
  } catch {
    return undefined;
  }
}

export function buildRemoteLensActorAddress(lensOrigin: string, preferredUsername: string): string {
  const uri = buildActivityPubUriContract(lensOrigin);
  return uri.webfingerAcct(preferredUsername);
}
