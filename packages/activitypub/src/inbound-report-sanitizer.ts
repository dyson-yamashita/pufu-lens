import sanitizeHtml from 'sanitize-html';

export const INBOUND_REPORT_MAX_TITLE_LENGTH = 300;
export const INBOUND_REPORT_MAX_SUMMARY_RAW_LENGTH = 32 * 1024;
export const INBOUND_REPORT_MAX_SUMMARY_SANITIZED_BYTES = 16 * 1024;
export const INBOUND_REPORT_MAX_URL_LENGTH = 2048;

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'a',
] as const;

function isSafeHttpsHref(href: string | undefined): boolean {
  if (!href?.startsWith('https://')) {
    return false;
  }
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: {
    a: ['href', 'rel'],
  },
  allowedSchemes: ['https'],
  allowedSchemesByTag: {
    a: ['https'],
  },
  exclusiveFilter(frame) {
    if (frame.tag === 'a') {
      return !isSafeHttpsHref(frame.attribs.href);
    }
    return false;
  },
  transformTags: {
    a: (_tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        href: attribs.href ?? '',
        rel: 'noopener noreferrer',
      },
    }),
  },
};

/** Sanitizes inbound Article summary/content HTML to a conservative allowlist. */
export function sanitizeInboundReportSummaryHtml(rawHtml: string): string {
  const sanitized = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  const bytes = new TextEncoder().encode(sanitized);
  if (bytes.byteLength > INBOUND_REPORT_MAX_SUMMARY_SANITIZED_BYTES) {
    throw new Error('Sanitized summary exceeds size limit');
  }
  return sanitized;
}

/** Validates and normalizes an inbound report HTTPS URL without credentials or fragments. */
export function assertInboundReportHttpsUrl(url: string, label: string): string {
  if (url.length === 0 || url.length > INBOUND_REPORT_MAX_URL_LENGTH) {
    throw new Error(`${label} exceeds maximum length`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (parsed.hash) {
    throw new Error(`${label} must not include a fragment`);
  }
  if (/\s/.test(url)) {
    throw new Error(`${label} must not include whitespace`);
  }
  return parsed.toString();
}

/** Validates HTTPS policy and blocked-domain predicate for inbound report URLs. */
export function assertInboundReportUrlAllowed(
  url: string,
  label: string,
  isDomainBlocked: (hostname: string) => boolean,
): string {
  const normalized = assertInboundReportHttpsUrl(url, label);
  if (isDomainBlocked(new URL(normalized).hostname.toLowerCase())) {
    throw new Error('Remote domain is blocked');
  }
  return normalized;
}

/** Validates a non-empty bounded inbound report title. */
export function assertInboundReportTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error('Title is required');
  }
  if (trimmed.length > INBOUND_REPORT_MAX_TITLE_LENGTH) {
    throw new Error('Title exceeds maximum length');
  }
  return trimmed;
}

/** Bounds raw summary/content before sanitization. */
export function assertInboundReportRawSummary(rawSummary: string): string {
  if (rawSummary.length > INBOUND_REPORT_MAX_SUMMARY_RAW_LENGTH) {
    throw new Error('Summary exceeds maximum length');
  }
  return rawSummary;
}
