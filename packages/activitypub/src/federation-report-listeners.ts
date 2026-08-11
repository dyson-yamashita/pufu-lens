import type { InboxContext, InboxListenerSetters } from '@fedify/fedify';
import { Announce, Create } from '@fedify/vocab';
import { normalizeRemoteActorUri } from './follow-model.ts';
import type { ActivityPubInboundReportUseCases } from './inbound-report-use-cases.ts';
import { ACTIVITYSTREAMS_PUBLIC_URI } from './remote-article.ts';
import { assertActivityPubListenerHarnessRuntime } from './test-runtime-guard.ts';

type InboxContextWithSignedKeyOwner = InboxContext<undefined> & {
  getSignedKeyOwner(): Promise<{ id?: URL | null } | null>;
};

/**
 * Registers verified Create/Announce inbox listeners on an existing listener set.
 *
 * Create accepts only embedded Article objects from raw JSON-LD and never dereferences
 * `Create.object` over the network. Announce passes the object URI to
 * `RemoteArticleResolver` for bounded fetch.
 */
export function registerReportInboxHandlers(
  listeners: InboxListenerSetters<undefined>,
  input: {
    inboundReportUseCases: ActivityPubInboundReportUseCases;
  },
): void {
  listeners.on(Create, async (ctx, activity) => {
    await handleInboundCreate(ctx, activity, input);
  });
  listeners.on(Announce, async (ctx, activity) => {
    await handleInboundAnnounce(ctx, activity, input);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleInboundCreate(
  ctx: InboxContext<undefined>,
  activity: Create,
  input: {
    inboundReportUseCases: ActivityPubInboundReportUseCases;
  },
): Promise<void> {
  const activityRecord = await activity.toJsonLd();
  if (!isRecord(activityRecord) || !hasPublicAddressing(activityRecord.to)) {
    return;
  }
  const activityUri =
    readOptionalHttpsUrlFromJsonLd(activityRecord.id) ?? readOptionalHttpsUrl(activity.id);
  const sourceActorUri =
    readOptionalHttpsUrlFromJsonLd(activityRecord.actor) ?? readOptionalHttpsUrl(activity.actorId);
  if (!activityUri || !sourceActorUri) {
    return;
  }
  if (!(await assertVerifiedActor(ctx, sourceActorUri))) {
    return;
  }
  const objectField = activityRecord.object;
  if (!isRecord(objectField)) {
    return;
  }
  await input.inboundReportUseCases.processVerifiedInboundCreate({
    activityUri,
    sourceActorUri,
    recipientPreferredUsername: ctx.recipient ?? null,
    embeddedObject: objectField,
  });
}

async function handleInboundAnnounce(
  ctx: InboxContext<undefined>,
  activity: Announce,
  input: {
    inboundReportUseCases: ActivityPubInboundReportUseCases;
  },
): Promise<void> {
  const activityUri = readOptionalHttpsUrl(activity.id);
  const sourceActorUri = readOptionalHttpsUrl(activity.actorId);
  const objectUri = readOptionalHttpsUrl(activity.objectId);
  if (!activityUri || !sourceActorUri || !objectUri) {
    return;
  }
  if (!(await assertVerifiedActor(ctx, sourceActorUri))) {
    return;
  }
  const activityRecord = await activity.toJsonLd();
  if (!isRecord(activityRecord) || !hasPublicAddressing(activityRecord.to)) {
    return;
  }
  await input.inboundReportUseCases.processVerifiedInboundAnnounce({
    activityUri,
    sourceActorUri,
    recipientPreferredUsername: ctx.recipient ?? null,
    objectUri,
  });
}

/**
 * Validates HTTP signature actor ownership when a test harness supplies `getSignedKeyOwner`.
 *
 * Fedify ingress verifies HTTP signatures before enqueue. Production `Federation.processQueuedTask`
 * uses an `InboxContext` without `getSignedKeyOwner` in Fedify 2.3.4, so queued delivery trusts
 * upstream verification. Raw signature headers are never persisted.
 */
async function assertVerifiedActor(
  ctx: InboxContext<undefined>,
  expectedActorUri: string,
): Promise<boolean> {
  const getSignedKeyOwner = readOptionalSignedKeyOwner(ctx);
  if (!getSignedKeyOwner) {
    return true;
  }
  const signedOwner = await getSignedKeyOwner();
  if (!signedOwner?.id) {
    return false;
  }
  return normalizeRemoteActorUri(signedOwner.id.href) === normalizeRemoteActorUri(expectedActorUri);
}

function readOptionalSignedKeyOwner(
  ctx: InboxContext<undefined>,
): InboxContextWithSignedKeyOwner['getSignedKeyOwner'] | undefined {
  const candidate = ctx as Partial<InboxContextWithSignedKeyOwner>;
  if (typeof candidate.getSignedKeyOwner === 'function') {
    return candidate.getSignedKeyOwner.bind(
      candidate,
    ) as InboxContextWithSignedKeyOwner['getSignedKeyOwner'];
  }
  return undefined;
}

function readOptionalHttpsUrl(value: URL | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value.href);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function readOptionalHttpsUrlFromJsonLd(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') {
        return null;
      }
      if (parsed.username || parsed.password || parsed.hash) {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }
  if (value instanceof URL) {
    return readOptionalHttpsUrl(value);
  }
  return null;
}

function hasPublicAddressing(to: unknown): boolean {
  if (!to) {
    return false;
  }
  const values = Array.isArray(to) ? to : [to];
  return values.some((entry) => {
    if (entry instanceof URL) {
      return entry.href === ACTIVITYSTREAMS_PUBLIC_URI;
    }
    if (typeof entry === 'string') {
      return entry === ACTIVITYSTREAMS_PUBLIC_URI;
    }
    return false;
  });
}

/** Test-only entrypoint for verified inbound Create listener handling. */
export async function invokeVerifiedInboundCreateListenerForTest(input: {
  inboundReportUseCases: ActivityPubInboundReportUseCases;
  ctx: InboxContext<undefined>;
  activity: Create;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  await handleInboundCreate(input.ctx, input.activity, input);
}

/** Test-only entrypoint for verified inbound Announce listener handling. */
export async function invokeVerifiedInboundAnnounceListenerForTest(input: {
  inboundReportUseCases: ActivityPubInboundReportUseCases;
  ctx: InboxContext<undefined>;
  activity: Announce;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  await handleInboundAnnounce(input.ctx, input.activity, input);
}
