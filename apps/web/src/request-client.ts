export function trustedClientIp(headers: Pick<Headers, 'get'>): string {
  return (
    lastForwardedIp(headers.get('x-forwarded-for')) ??
    normalizeClientIp(headers.get('x-real-ip')) ??
    'anonymous'
  );
}

export function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function lastForwardedIp(value: string | null): string | undefined {
  const forwarded = value
    ?.split(',')
    .map((part) => normalizeClientIp(part))
    .filter((part): part is string => Boolean(part));
  return forwarded?.at(-1);
}

function normalizeClientIp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return undefined;
  }
  return trimmed;
}
