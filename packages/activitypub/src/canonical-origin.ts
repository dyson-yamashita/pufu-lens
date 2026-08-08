export type CanonicalOriginOptions = {
  /** Allows `http://localhost` only for explicit local protocol fixtures. */
  allowHttpLocalhost?: boolean;
};

/** Validates a fixed canonical origin used for ActivityPub URL generation. */
export function validateCanonicalOrigin(origin: string, options: CanonicalOriginOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('canonical origin must be an absolute URL');
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('canonical origin must not include credentials, path, query, or fragment');
  }

  const isLocalhostHttp =
    options.allowHttpLocalhost === true &&
    parsed.protocol === 'http:' &&
    parsed.hostname === 'localhost';

  if (parsed.protocol !== 'https:' && !isLocalhostHttp) {
    throw new Error('canonical origin must use HTTPS');
  }

  return parsed;
}

/** Parses and validates a canonical origin string. */
export function parseCanonicalOrigin(
  origin: string,
  options: CanonicalOriginOptions = {},
): { origin: string; host: string } {
  const parsed = validateCanonicalOrigin(origin, options);
  return {
    origin: parsed.origin,
    host: parsed.host,
  };
}
