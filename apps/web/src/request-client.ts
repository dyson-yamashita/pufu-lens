import { isIP } from 'node:net';

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
  return forwarded?.findLast((ip) => !isPrivateOrLocalIp(ip));
}

function normalizeClientIp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown' || isIP(trimmed) === 0) {
    return undefined;
  }
  return trimmed;
}

function isPrivateOrLocalIp(ip: string): boolean {
  const ipVersion = isIP(ip);
  if (ipVersion === 4) {
    const [first = 0, second = 0] = ip.split('.').map((part) => Number.parseInt(part, 10));
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  const normalized = ip.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}
