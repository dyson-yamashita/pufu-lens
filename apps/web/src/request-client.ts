export function trustedClientIp(headers: Pick<Headers, 'get'>): string {
  return (
    firstForwardedIp(headers.get('x-forwarded-for')) ??
    normalizeClientIp(headers.get('x-real-ip')) ??
    'anonymous'
  );
}

function firstForwardedIp(value: string | null): string | undefined {
  return normalizeClientIp(value?.split(',')[0]);
}

function normalizeClientIp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return undefined;
  }
  return trimmed;
}
