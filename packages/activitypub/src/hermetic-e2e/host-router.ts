import { type DocumentLoader, getDocumentLoader } from '@fedify/vocab-runtime';
import { assertActivityPubHermeticE2eRuntime } from '../test-runtime-guard.ts';
import { applyHermeticFault, type HermeticFaultController } from './fault-controller.ts';
import {
  detectDigestKind,
  type ProtocolTraceCollector,
  readActivityIdFromJson,
  readActivityTypeFromJson,
} from './protocol-trace.ts';

const ALLOWED_HOSTS = new Set(['lens-a.test', 'lens-b.test', 'mastodon.test']);

export type HostHandler = (request: Request) => Promise<Response>;

export type HostRouter = {
  register(host: string, handler: HostHandler): void;
  install(input: {
    faultController: HermeticFaultController;
    trace: ProtocolTraceCollector;
  }): () => void;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
};

/** Creates a fail-closed host router for hermetic ActivityPub E2E transport. */
export function createHostRouter(): HostRouter {
  assertActivityPubHermeticE2eRuntime();
  const handlers = new Map<string, HostHandler>();
  let installed = false;
  let originalFetch: typeof fetch | undefined;

  return {
    register(host: string, handler: HostHandler) {
      if (!ALLOWED_HOSTS.has(host)) {
        throw new Error(`Host router rejected unapproved host: ${host}`);
      }
      handlers.set(host, handler);
    },
    install({ faultController, trace }) {
      if (installed) {
        throw new Error('Host router is already installed');
      }
      installed = true;
      originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
        routeFetch({
          requestInput: input,
          init,
          handlers,
          faultController,
          trace,
        })) as typeof fetch;
      return () => {
        if (originalFetch) {
          globalThis.fetch = originalFetch;
        }
        installed = false;
      };
    },
    async fetch(input, init) {
      return routeFetch({
        requestInput: input,
        init,
        handlers,
        faultController: null,
        trace: null,
      });
    },
  };
}

/** Creates a JSON-LD loader that routes fixture documents in-memory and keeps cached contexts local. */
export function createHermeticDocumentLoader(fetchImpl: typeof fetch): DocumentLoader {
  assertActivityPubHermeticE2eRuntime();
  const contextLoader = getDocumentLoader({ allowPrivateAddress: true });
  return async (url) => {
    const parsedUrl = new URL(url);
    if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
      return contextLoader(url);
    }
    const documentUrl = parsedUrl;
    documentUrl.hash = '';
    const response = await fetchImpl(documentUrl, {
      headers: { accept: 'application/activity+json, application/ld+json' },
    });
    if (!response.ok) {
      throw new Error(`Hermetic document loader received ${response.status}`);
    }
    return {
      contextUrl: null,
      documentUrl: documentUrl.href,
      document: await response.json(),
    };
  };
}

async function routeFetch(input: {
  requestInput: string | URL | Request;
  init?: RequestInit;
  handlers: Map<string, HostHandler>;
  faultController: HermeticFaultController | null;
  trace: ProtocolTraceCollector | null;
}): Promise<Response> {
  const request =
    input.requestInput instanceof Request && input.init === undefined
      ? input.requestInput
      : new Request(input.requestInput, input.init);
  const url = new URL(request.url);
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`Hermetic host router blocked external host: ${url.hostname}`);
  }
  const handler = input.handlers.get(url.hostname);
  if (!handler) {
    return new Response('not found', { status: 404 });
  }

  const fault = input.faultController?.resolveFault(url, request.method) ?? null;
  const bodyText =
    request.method === 'POST' && request.body !== null ? await request.clone().text() : '';
  const execute = async () => handler(request);
  let response: Response;
  try {
    response =
      fault === null ? await execute() : await applyHermeticFault(fault, execute, request.signal);
  } catch (error) {
    input.trace?.record({
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      status: 599,
      activityType: bodyText ? readActivityTypeFromJson(bodyText) : undefined,
      activityId: bodyText ? readActivityIdFromJson(bodyText) : undefined,
      signed: request.headers.has('signature') || request.headers.has('Signature'),
      digestKind: detectDigestKind(request.headers),
    });
    throw error;
  }

  input.trace?.record({
    method: request.method,
    host: url.hostname,
    path: url.pathname,
    status: response.status,
    activityType: bodyText ? readActivityTypeFromJson(bodyText) : undefined,
    activityId: bodyText ? readActivityIdFromJson(bodyText) : undefined,
    signed: request.headers.has('signature') || request.headers.has('Signature'),
    digestKind: detectDigestKind(request.headers),
  });

  return response;
}
