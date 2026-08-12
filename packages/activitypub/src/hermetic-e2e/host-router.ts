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
const FEDIFY_PRELOADED_CONTEXT_URLS = new Set([
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  'https://w3id.org/security/data-integrity/v1',
  'https://w3id.org/security/data-integrity/v2',
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/multikey/v1',
  'https://w3id.org/identity/v1',
  'https://purl.archive.org/socialweb/webfinger',
  'http://schema.org/',
  'https://gotosocial.org/ns',
  'https://w3id.org/fep/5711',
  'https://join-lemmy.org/context.json',
  'http://joinmastodon.org/ns',
  'https://purl.archive.org/miscellany',
]);

function normalizeContextUrl(url: string): string {
  const parsedUrl = new URL(url);
  parsedUrl.hash = '';
  return parsedUrl.href;
}

function isAllowedPreloadedContextUrl(url: string): boolean {
  return FEDIFY_PRELOADED_CONTEXT_URLS.has(normalizeContextUrl(url));
}

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
          originalFetch = undefined;
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
  return async (url) => {
    const parsedUrl = new URL(url);
    parsedUrl.hash = '';
    if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
      throw new Error(`Hermetic document loader rejected external document: ${url}`);
    }
    const response = await fetchImpl(parsedUrl, {
      headers: { accept: 'application/activity+json, application/ld+json' },
    });
    if (!response.ok) {
      throw new Error(`Hermetic document loader received ${response.status}`);
    }
    return {
      contextUrl: null,
      documentUrl: parsedUrl.href,
      document: await response.json(),
    };
  };
}

/** Loads only the Fedify-preloaded JSON-LD contexts permitted in hermetic E2E. */
export function createHermeticContextLoader(): DocumentLoader {
  assertActivityPubHermeticE2eRuntime();
  const contextLoader = getDocumentLoader({ allowPrivateAddress: true });
  return async (url) => {
    if (!isAllowedPreloadedContextUrl(url)) {
      throw new Error(`Hermetic context loader rejected external context: ${url}`);
    }
    return contextLoader(url);
  };
}

/** Combines hermetic document and context loaders for code paths that use one loader for both. */
export function createHermeticCombinedLoader(fetchImpl: typeof fetch): DocumentLoader {
  const documentLoader = createHermeticDocumentLoader(fetchImpl);
  const contextLoader = createHermeticContextLoader();
  return async (url) => {
    const parsedUrl = new URL(url);
    parsedUrl.hash = '';
    if (ALLOWED_HOSTS.has(parsedUrl.hostname)) {
      return documentLoader(url);
    }
    if (isAllowedPreloadedContextUrl(url)) {
      return contextLoader(url);
    }
    throw new Error(`Hermetic combined loader rejected external URL: ${url}`);
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
    input.trace?.record(buildRouteTraceEntry({ request, url, bodyText, status: 599 }));
    throw error;
  }

  input.trace?.record(buildRouteTraceEntry({ request, url, bodyText, status: response.status }));

  return response;
}

function buildRouteTraceEntry(input: {
  request: Request;
  url: URL;
  bodyText: string;
  status: number;
}) {
  return {
    method: input.request.method,
    host: input.url.hostname,
    path: input.url.pathname,
    status: input.status,
    activityType: input.bodyText ? readActivityTypeFromJson(input.bodyText) : undefined,
    activityId: input.bodyText ? readActivityIdFromJson(input.bodyText) : undefined,
    signed: input.request.headers.has('signature') || input.request.headers.has('Signature'),
    digestKind: detectDigestKind(input.request.headers),
  };
}
