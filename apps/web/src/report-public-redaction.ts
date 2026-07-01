export function redactItems(items: readonly Record<string, unknown>[] | undefined) {
  return items?.map((item) => redactRecord(item));
}

export function redactText(value: string): string {
  const emailRedacted = replaceEmails(value, '[redacted-email]');
  return replacePrivateTokens(emailRedacted);
}

const PDF_TEXT_DENYLIST = [
  /raw[_-]?document[_-]?id/giu,
  /private[_-]?raw[_-]?locator/giu,
  /storage[_-]?uri/giu,
  /\bsecret(?:\s+|=|:)\s*\S+/giu,
  /\bapi[_-]?key(?:\s+|=|:)\s*\S+/giu,
  /\btoken(?:\s+|=|:)\s*\S+/giu,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,
] as const;

const PDF_GENERIC_URI_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s)\]"']+/giu;
const PDF_REDACTION_PLACEHOLDER = /\[redacted(?:-[a-z]+)?\]/giu;

export function redactSensitivePdfText(value: string): string {
  let text = redactText(value);
  text = text.replace(PDF_GENERIC_URI_PATTERN, '[redacted]');
  for (const pattern of PDF_TEXT_DENYLIST) {
    text = text.replace(pattern, '[redacted]');
  }
  return text.replace(PDF_REDACTION_PLACEHOLDER, '[redacted]');
}

export function containsPrivateText(value: string): boolean {
  return hasEmail(value) || privateTokenRanges(value).length > 0;
}

export function publicSourceLabel(docType: string, index: number): string {
  return `公開ソース ${index + 1} (${redactText(docType)})`;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_PUBLIC_REPORT_KEYS.has(key))
      .map(([key, fieldValue]) => [key, redactUnknown(fieldValue)]),
  );
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (isRecord(value)) {
    return redactRecord(value);
  }
  return value;
}

function hasEmail(value: string): boolean {
  return emailRanges(value).length > 0;
}

function replaceEmails(value: string, replacement: string): string {
  const ranges = emailRanges(value);
  if (ranges.length === 0) {
    return value;
  }

  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += value.slice(cursor, range.start);
    output += replacement;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

function emailRanges(value: string): { end: number; start: number }[] {
  const ranges: { end: number; start: number }[] = [];
  let index = 0;
  while (index < value.length) {
    const atIndex = value.indexOf('@', index);
    if (atIndex === -1) {
      break;
    }

    const start = emailLocalStart(value, atIndex);
    const end = emailDomainEnd(value, atIndex);
    if (start < atIndex && end > atIndex + 1 && hasEmailTopLevelDomain(value, atIndex + 1, end)) {
      ranges.push({ end, start });
      index = end;
    } else {
      index = atIndex + 1;
    }
  }
  return ranges;
}

function emailLocalStart(value: string, atIndex: number): number {
  let cursor = atIndex - 1;
  while (cursor >= 0 && isEmailLocalChar(value.charCodeAt(cursor))) {
    cursor -= 1;
  }
  return cursor + 1;
}

function emailDomainEnd(value: string, atIndex: number): number {
  let cursor = atIndex + 1;
  while (cursor < value.length && isEmailDomainChar(value.charCodeAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

function hasEmailTopLevelDomain(value: string, domainStart: number, domainEnd: number): boolean {
  const lastDot = value.lastIndexOf('.', domainEnd - 1);
  if (lastDot < domainStart || domainEnd - lastDot - 1 < 2) {
    return false;
  }

  for (let index = lastDot + 1; index < domainEnd; index += 1) {
    if (!isAsciiAlpha(value.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

function isEmailLocalChar(code: number): boolean {
  return (
    isAsciiAlphaNumeric(code) ||
    code === 37 ||
    code === 43 ||
    code === 45 ||
    code === 46 ||
    code === 95
  );
}

function isEmailDomainChar(code: number): boolean {
  return isAsciiAlphaNumeric(code) || code === 45 || code === 46;
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiAlpha(code) || (code >= 48 && code <= 57);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function replacePrivateTokens(value: string): string {
  const ranges = privateTokenRanges(value);
  if (ranges.length === 0) {
    return value;
  }
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += value.slice(cursor, range.start);
    output += range.replacement;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

function privateTokenRanges(value: string): { end: number; replacement: string; start: number }[] {
  const ranges: { end: number; replacement: string; start: number }[] = [];
  const lowerValue = value.toLowerCase();
  let index = 0;
  while (index < value.length) {
    const uriStart = nextUriStart(lowerValue, index);
    if (!uriStart) {
      break;
    }
    const end = tokenEnd(value, uriStart.index);
    const token = value.slice(uriStart.index, end);
    if (uriStart.scheme === 'file' || uriStart.scheme === 'gs') {
      ranges.push({ end, replacement: '[redacted-uri]', start: uriStart.index });
    } else if (isPrivateHttpUrl(token)) {
      ranges.push({ end, replacement: '[redacted-url]', start: uriStart.index });
    }
    index = Math.max(end, uriStart.index + uriStart.scheme.length + 3);
  }
  return ranges;
}

function nextUriStart(
  lowerValue: string,
  fromIndex: number,
): { index: number; scheme: string } | undefined {
  const schemes = ['https', 'http', 'file', 'gs'];
  let found: { index: number; scheme: string } | undefined;
  for (const scheme of schemes) {
    const index = lowerValue.indexOf(`${scheme}://`, fromIndex);
    if (index >= 0 && (!found || index < found.index)) {
      found = { index, scheme };
    }
  }
  return found;
}

function tokenEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length && !isUriTerminator(value.charAt(index))) {
    index += 1;
  }
  return index;
}

function isUriTerminator(char: string): boolean {
  return char.trim() === '' || char === ')' || char === '"' || char === "'" || char === '<';
}

function isPrivateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      isPrivateIpv4Host(hostname) ||
      isPrivateIpv6Host(hostname) ||
      hostname.includes('internal') ||
      hostname.includes('corp') ||
      hostname.includes('intranet') ||
      hostname.split('.').includes('local')
    );
  } catch {
    return false;
  }
}

function isPrivateIpv4Host(hostname: string): boolean {
  return (
    isLoopbackIpv4Host(hostname) ||
    hostname === '0.0.0.0' ||
    isPrivate10Host(hostname) ||
    isPrivate172Host(hostname) ||
    isPrivate192Host(hostname) ||
    isLinkLocalHost(hostname)
  );
}

function isLoopbackIpv4Host(hostname: string): boolean {
  return hostname.startsWith('127.') && isIpv4Host(hostname);
}

function isPrivate10Host(hostname: string): boolean {
  if (!hostname.startsWith('10.')) {
    return false;
  }
  return isIpv4Host(hostname);
}

function isPrivate172Host(hostname: string): boolean {
  if (!hostname.startsWith('172.')) {
    return false;
  }
  if (!isIpv4Host(hostname)) {
    return false;
  }
  const secondOctet = Number(hostname.split('.')[1]);
  return Number.isInteger(secondOctet) && secondOctet >= 16 && secondOctet <= 31;
}

function isPrivate192Host(hostname: string): boolean {
  if (!hostname.startsWith('192.168.')) {
    return false;
  }
  return isIpv4Host(hostname);
}

function isLinkLocalHost(hostname: string): boolean {
  return hostname.startsWith('169.254.') && isIpv4Host(hostname);
}

function isPrivateIpv6Host(hostname: string): boolean {
  const mappedIpv4 = ipv4FromMappedIpv6Host(hostname);
  if (mappedIpv4) {
    return isPrivateIpv4Host(mappedIpv4);
  }

  return (
    hostname === '[::1]' ||
    hostname === '[::]' ||
    hostname.startsWith('[fc') ||
    hostname.startsWith('[fd') ||
    hostname.startsWith('[fe8') ||
    hostname.startsWith('[fe9') ||
    hostname.startsWith('[fea') ||
    hostname.startsWith('[feb')
  );
}

function ipv4FromMappedIpv6Host(hostname: string): string | undefined {
  if (!hostname.startsWith('[::ffff:') || !hostname.endsWith(']')) {
    return undefined;
  }
  const mappedValue = hostname.slice('[::ffff:'.length, -1);
  if (isIpv4Host(mappedValue)) {
    return mappedValue;
  }

  const parts = mappedValue.split(':');
  if (parts.length !== 2) {
    return undefined;
  }
  const [highPart, lowPart] = parts;
  if (highPart === undefined || lowPart === undefined) {
    return undefined;
  }
  const high = parseIpv6Hextet(highPart);
  const low = parseIpv6Hextet(lowPart);
  if (high === undefined || low === undefined) {
    return undefined;
  }

  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function parseIpv6Hextet(value: string): number | undefined {
  if (value === '' || value.length > 4) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHexDigit =
      (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
    if (!isHexDigit) {
      return undefined;
    }
  }
  const parsed = Number.parseInt(value, 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : undefined;
}

function isIpv4Host(hostname: string): boolean {
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (part === '' || part.length > 3) {
        return false;
      }
      for (let index = 0; index < part.length; index += 1) {
        const code = part.charCodeAt(index);
        if (code < 48 || code > 57) {
          return false;
        }
      }
      const value = Number(part);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    })
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PRIVATE_PUBLIC_REPORT_KEYS = new Set([
  'canonical_uri',
  'document_id',
  'parsed_uri',
  'project_id',
  'raw_uri',
  'snippet',
  'storage_uri',
]);
