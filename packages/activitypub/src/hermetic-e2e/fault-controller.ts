import type { ActivityPubDispatcherClock } from '../dispatcher.ts';

export type HermeticFaultKind =
  | 'timeout'
  | 'http_429'
  | 'http_503'
  | 'offline'
  | 'accept_then_fail';

export type HermeticFaultTarget = {
  readonly host: string;
  readonly pathPrefix?: string;
};

const HERMETIC_ABORT_WAIT_MS = 100;

/** Virtual clock and network fault injection for hermetic ActivityPub E2E. */
export class HermeticFaultController {
  #now: Date;
  readonly #faults = new Map<string, HermeticFaultKind>();

  constructor(startAt = new Date()) {
    this.#now = new Date(startAt.getTime());
  }

  readonly clock: ActivityPubDispatcherClock = {
    now: () => this.#now,
  };

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }

  setFault(target: HermeticFaultTarget, kind: HermeticFaultKind | null): void {
    const key = faultKey(target);
    if (kind === null) {
      this.#faults.delete(key);
      return;
    }
    this.#faults.set(key, kind);
  }

  clearFaults(): void {
    this.#faults.clear();
  }

  resolveFault(url: URL, method: string): HermeticFaultKind | null {
    let bestMatch: { pathPrefix: string; kind: HermeticFaultKind } | null = null;
    for (const [key, kind] of this.#faults.entries()) {
      const [host, pathPrefix = ''] = key.split('|');
      if (url.hostname !== host) {
        continue;
      }
      if (pathPrefix && !url.pathname.startsWith(pathPrefix)) {
        continue;
      }
      if (kind === 'accept_then_fail' && method.toUpperCase() !== 'POST') {
        continue;
      }
      if (!bestMatch || pathPrefix.length > bestMatch.pathPrefix.length) {
        bestMatch = { pathPrefix, kind };
      }
    }
    return bestMatch?.kind ?? null;
  }
}

function faultKey(target: HermeticFaultTarget): string {
  return `${target.host}|${target.pathPrefix ?? ''}`;
}

export async function applyHermeticFault(
  fault: HermeticFaultKind,
  run: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  switch (fault) {
    case 'timeout':
      await waitForAbort(signal);
      throw new DOMException('Hermetic delivery timeout', 'AbortError');
    case 'http_429':
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } });
    case 'http_503':
      return new Response('unavailable', { status: 503 });
    case 'offline':
      throw new TypeError('fetch failed');
    case 'accept_then_fail':
      return run().then(() => {
        throw new TypeError('fetch failed');
      });
  }
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return Promise.reject(new Error('Hermetic timeout requires an AbortSignal'));
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Hermetic abort wait timed out'));
    }, HERMETIC_ABORT_WAIT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
