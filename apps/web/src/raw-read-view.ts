import type postgres from 'postgres';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';

type RawSourceType = 'drive' | 'github' | 'gmail' | 'web';

export type RawReadViewSourceLocator =
  | { readonly kind: 'message'; readonly messageIndex: number }
  | { readonly kind: 'quote'; readonly messageIndex: number; readonly quoteIndex: number }
  | { readonly headingId: string; readonly kind: 'heading' }
  | { readonly kind: 'paragraph'; readonly paragraphIndex: number }
  | { readonly kind: 'issue_body' }
  | { readonly commentIndex: number; readonly kind: 'comment' }
  | { readonly kind: 'review'; readonly reviewIndex: number }
  | { readonly filePath: string; readonly hunkIndex: number; readonly kind: 'diff_hunk' }
  | { readonly kind: 'main_text_section'; readonly sectionIndex: number }
  | { readonly kind: 'link_context'; readonly linkIndex: number };

export interface AgentRawReadViewSection {
  readonly actorHints?: readonly string[];
  readonly id: string;
  readonly label: string;
  readonly occurredAt?: string;
  readonly sourceLocator: RawReadViewSourceLocator;
  readonly text: string;
  readonly untrusted: true;
}

export interface RawReadViewLimits {
  readonly availableSectionIds: readonly string[];
  readonly maxChars: number;
  readonly maxSections: number;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface RawReadViewRedaction {
  readonly count: number;
  readonly kind: 'email' | 'secret';
}

export interface AgentRawReadView {
  readonly canonicalUri?: string;
  readonly documentId?: string;
  readonly limits: RawReadViewLimits;
  readonly projectSlug: string;
  readonly rawDocumentId: string;
  readonly redactions: readonly RawReadViewRedaction[];
  readonly sections: readonly AgentRawReadViewSection[];
  readonly sourceId: string;
  readonly sourceType: RawSourceType;
  readonly title?: string;
  readonly traceSummary: string;
}

export interface AgentRawReadViewEnvelope {
  readonly data: AgentRawReadView;
  readonly kind: 'agent_raw_read_view';
  readonly trust: 'untrusted_external_content';
}

export interface RawReadViewRequest {
  readonly aroundSectionId?: string;
  readonly cursor?: string;
  readonly documentId?: string;
  readonly maxChars?: number;
  readonly maxSections?: number;
  readonly projectId: string;
  readonly rawDocumentId: string;
  readonly sectionSelector?: readonly string[];
}

export interface RawReadViewRawDocument {
  readonly canonicalUri?: string | null;
  readonly documentId?: string | null;
  readonly projectSlug: string;
  readonly rawDocumentId: string;
  readonly sourceId: string;
  readonly sourceType: RawSourceType;
  readonly storageUri: string;
  readonly title?: string | null;
}

export interface RawReadViewLookup {
  lookupRawReadViewDocument(input: {
    readonly documentId?: string;
    readonly projectId: string;
    readonly rawDocumentId: string;
  }): Promise<RawReadViewRawDocument | undefined>;
}

export interface RawReadViewRepository {
  fetchRawReadView(input: RawReadViewRequest): Promise<AgentRawReadViewEnvelope | undefined>;
}

export class RawReadViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawReadViewError';
  }
}

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_SECTIONS = 8;
const MAX_AVAILABLE_SECTION_IDS = 100;

export function createRawReadViewRepository(input: {
  readonly lookup: RawReadViewLookup;
  readonly storage: Pick<ObjectStorage, 'getText'>;
}): RawReadViewRepository {
  return {
    async fetchRawReadView(request) {
      const rawDocument = await input.lookup.lookupRawReadViewDocument(request);
      if (!rawDocument) {
        return undefined;
      }
      const rawText = await input.storage.getText(rawDocument.storageUri);
      return buildAgentRawReadView({ rawDocument, rawText, request });
    },
  };
}

export function createPostgresRawReadViewRepository(input: {
  readonly sql: postgres.Sql;
  readonly storage: Pick<ObjectStorage, 'getText'>;
}): RawReadViewRepository {
  return createRawReadViewRepository({
    lookup: {
      async lookupRawReadViewDocument({ documentId, projectId, rawDocumentId }) {
        const rows = (await input.sql`
          SELECT
            p.slug AS project_slug,
            rd.id::text AS raw_document_id,
            rd.source_id,
            rd.source_type,
            rd.storage_uri,
            coalesce(d.id::text, NULL) AS document_id,
            coalesce(d.title, NULL) AS title,
            coalesce(d.canonical_uri, rd.source_uri, NULL) AS canonical_uri
          FROM public.raw_documents rd
          JOIN public.projects p ON p.id = rd.project_id
          LEFT JOIN public.documents d
            ON d.raw_document_id = rd.id
            AND d.project_id = rd.project_id
          WHERE rd.project_id = ${projectId}
            AND rd.id = ${rawDocumentId}
            AND (${documentId ?? null}::text IS NULL OR d.id::text = ${documentId ?? null})
          LIMIT 1
        `) as readonly unknown[];
        const row = rows[0];
        if (!row) {
          return undefined;
        }
        return rawDocumentFromRow(row);
      },
    },
    storage: input.storage,
  });
}

export function buildAgentRawReadView(input: {
  readonly rawDocument: RawReadViewRawDocument;
  readonly rawText: string;
  readonly request?: Partial<
    Pick<
      RawReadViewRequest,
      'aroundSectionId' | 'cursor' | 'maxChars' | 'maxSections' | 'sectionSelector'
    >
  >;
}): AgentRawReadViewEnvelope {
  const allSections = sectionsForRaw(input.rawDocument, input.rawText);
  const limits = {
    maxChars: input.request?.maxChars ?? DEFAULT_MAX_CHARS,
    maxSections: input.request?.maxSections ?? DEFAULT_MAX_SECTIONS,
  };
  const selected = selectSections(allSections, input.request);
  const bounded = boundSections(selected.sections, limits);
  const redaction = createRedactionTracker();
  const redactedSections = bounded.sections.map((section) => ({
    ...section,
    actorHints: section.actorHints?.map((hint) => redaction.redact(hint)),
    text: redaction.redact(section.text),
  }));
  const redactions = redaction.summary();
  const truncated = selected.truncated || bounded.truncated;
  const nextOffset = nextSectionOffset(selected, bounded);
  const nextCursor =
    truncated && typeof nextOffset === 'number' && nextOffset < allSections.length
      ? encodeCursor(nextOffset)
      : null;

  return {
    kind: 'agent_raw_read_view',
    trust: 'untrusted_external_content',
    data: {
      ...(input.rawDocument.canonicalUri ? { canonicalUri: input.rawDocument.canonicalUri } : {}),
      ...(input.rawDocument.documentId ? { documentId: input.rawDocument.documentId } : {}),
      limits: {
        availableSectionIds: allSections
          .map((section) => section.id)
          .slice(0, MAX_AVAILABLE_SECTION_IDS),
        maxChars: limits.maxChars,
        maxSections: limits.maxSections,
        nextCursor,
        truncated,
      },
      projectSlug: input.rawDocument.projectSlug,
      rawDocumentId: input.rawDocument.rawDocumentId,
      redactions,
      sections: redactedSections,
      sourceId: input.rawDocument.sourceId,
      sourceType: input.rawDocument.sourceType,
      ...(input.rawDocument.title ? { title: input.rawDocument.title } : {}),
      traceSummary: `${input.rawDocument.sourceType} raw read view: ${redactedSections.length}/${allSections.length} sections${
        truncated ? ', truncated' : ''
      }`,
    },
  };
}

function sectionsForRaw(
  rawDocument: RawReadViewRawDocument,
  rawText: string,
): AgentRawReadViewSection[] {
  if (rawDocument.sourceType === 'web') {
    return webSections(rawText);
  }
  const parsed = parseJson(rawText);
  switch (rawDocument.sourceType) {
    case 'drive':
      return driveSections(parsed);
    case 'github':
      return githubSections(parsed);
    case 'gmail':
      return gmailSections(parsed);
    default:
      throw new RawReadViewError('Unsupported raw source type.');
  }
}

function githubSections(value: unknown): AgentRawReadViewSection[] {
  const raw = requireRecord(value);
  const sections: AgentRawReadViewSection[] = [];
  const title = optionalString(raw.title);
  const body = optionalString(raw.body);
  if (body) {
    sections.push(
      section('body', title ? `body: ${title}` : 'body', body, {
        actorHints: actorHints(raw.user),
        occurredAt: optionalString(raw.created_at),
        sourceLocator: { kind: 'issue_body' },
      }),
    );
  }
  const comments = Array.isArray(raw.comments) ? raw.comments : [];
  comments.forEach((comment, index) => {
    const record = requireRecord(comment);
    const text = optionalString(record.body);
    if (text) {
      sections.push(
        section(`comment_${index + 1}`, `comment #${index + 1}`, text, {
          actorHints: actorHints(record.user),
          sourceLocator: { commentIndex: index, kind: 'comment' },
        }),
      );
    }
  });
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : [];
  reviews.forEach((review, index) => {
    const record = requireRecord(review);
    const text = optionalString(record.body) ?? optionalString(record.state);
    if (text) {
      sections.push(
        section(`review_${index + 1}`, `review #${index + 1}`, text, {
          actorHints: actorHints(record.user),
          sourceLocator: { kind: 'review', reviewIndex: index },
        }),
      );
    }
  });
  const diffHunks = Array.isArray(raw.diffHunks) ? raw.diffHunks : [];
  diffHunks.forEach((hunk, index) => {
    const record = requireRecord(hunk);
    const text = optionalString(record.patch) ?? optionalString(record.body);
    if (text) {
      sections.push(
        section(`diff_hunk_${index + 1}`, `diff hunk #${index + 1}`, text, {
          sourceLocator: {
            filePath:
              optionalString(record.filePath) ?? optionalString(record.filename) ?? 'unknown',
            hunkIndex: index,
            kind: 'diff_hunk',
          },
        }),
      );
    }
  });
  return requireNonEmptySections(sections);
}

function gmailSections(value: unknown): AgentRawReadViewSection[] {
  const raw = requireRecord(value);
  const sections: AgentRawReadViewSection[] = [];
  const body = optionalString(raw.bodyText);
  if (body) {
    sections.push(
      section('message_latest', optionalString(raw.subject) ?? 'latest message', body, {
        actorHints: actorHints(raw.from),
        occurredAt: optionalString(raw.sentAt),
        sourceLocator: { kind: 'message', messageIndex: 0 },
      }),
    );
  }
  const quotedMessages = Array.isArray(raw.quotedMessages) ? raw.quotedMessages : [];
  quotedMessages.forEach((quoted, index) => {
    const record = requireRecord(quoted);
    const text = optionalString(record.bodyText);
    if (text) {
      sections.push(
        section(`quote_${index + 1}`, `quote #${index + 1}`, text, {
          actorHints: actorHints(record.from),
          occurredAt: optionalString(record.sentAt),
          sourceLocator: { kind: 'quote', messageIndex: index + 1, quoteIndex: index },
        }),
      );
    }
  });
  return requireNonEmptySections(sections);
}

function driveSections(value: unknown): AgentRawReadViewSection[] {
  const raw = requireRecord(value);
  const sections: AgentRawReadViewSection[] = [];
  const title = optionalString(raw.title);
  if (title) {
    sections.push(
      section('title', 'title', title, {
        actorHints: Array.isArray(raw.owners)
          ? raw.owners.flatMap((owner) => actorHints(owner))
          : [],
        occurredAt: optionalString(raw.modifiedTime),
        sourceLocator: { headingId: 'title', kind: 'heading' },
      }),
    );
  }
  const paragraphs = splitParagraphs(optionalString(raw.bodyText) ?? '');
  paragraphs.forEach((paragraph, index) => {
    sections.push(
      section(`paragraph_${index + 1}`, `paragraph #${index + 1}`, paragraph, {
        occurredAt: optionalString(raw.modifiedTime),
        sourceLocator: { kind: 'paragraph', paragraphIndex: index },
      }),
    );
  });
  return requireNonEmptySections(sections);
}

function webSections(rawText: string): AgentRawReadViewSection[] {
  const title = decodeHtml(
    rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
      rawText.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
      '',
  ).trim();
  const withoutScripts = rawText
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  const text = decodeHtml(withoutScripts.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const sections: AgentRawReadViewSection[] = [];
  if (title) {
    sections.push(
      section('title', 'title', title, {
        sourceLocator: { kind: 'main_text_section', sectionIndex: 0 },
      }),
    );
  }
  splitParagraphs(text).forEach((paragraph, index) => {
    sections.push(
      section(`main_text_${index + 1}`, `main text #${index + 1}`, paragraph, {
        sourceLocator: { kind: 'main_text_section', sectionIndex: index + 1 },
      }),
    );
  });
  return requireNonEmptySections(sections);
}

function section(
  id: string,
  label: string,
  text: string,
  input: {
    readonly actorHints?: readonly string[];
    readonly occurredAt?: string;
    readonly sourceLocator: RawReadViewSourceLocator;
  },
): AgentRawReadViewSection {
  return {
    ...(input.actorHints?.length ? { actorHints: input.actorHints } : {}),
    id,
    label,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    sourceLocator: input.sourceLocator,
    text,
    untrusted: true,
  };
}

function selectSections(
  sections: readonly AgentRawReadViewSection[],
  request: Partial<Pick<RawReadViewRequest, 'aroundSectionId' | 'cursor' | 'sectionSelector'>> = {},
): {
  readonly baseOffset?: number;
  readonly canPage: boolean;
  readonly nextOffset?: number;
  readonly sections: readonly AgentRawReadViewSection[];
  readonly truncated: boolean;
} {
  if (request.sectionSelector?.length) {
    const selectedIds = new Set(request.sectionSelector);
    return {
      canPage: false,
      sections: sections.filter((section) => selectedIds.has(section.id)),
      truncated: false,
    };
  }
  if (request.aroundSectionId) {
    const index = sections.findIndex((section) => section.id === request.aroundSectionId);
    if (index < 0) {
      return { canPage: false, sections: [], truncated: false };
    }
    const endOffset = Math.min(sections.length, index + 2);
    return {
      canPage: endOffset < sections.length,
      nextOffset: endOffset,
      sections: sections.slice(Math.max(0, index - 1), endOffset),
      truncated: index > 1 || endOffset < sections.length,
    };
  }
  const offset = decodeCursor(request.cursor);
  return {
    baseOffset: offset,
    canPage: true,
    sections: sections.slice(offset),
    truncated: false,
  };
}

function nextSectionOffset(
  selected: ReturnType<typeof selectSections>,
  bounded: ReturnType<typeof boundSections>,
): number | undefined {
  if (!selected.canPage) {
    return undefined;
  }
  if (typeof selected.baseOffset === 'number' && typeof bounded.nextOffset === 'number') {
    return selected.baseOffset + bounded.nextOffset;
  }
  return selected.nextOffset;
}

function boundSections(
  sections: readonly AgentRawReadViewSection[],
  limits: { readonly maxChars: number; readonly maxSections: number },
): {
  readonly nextOffset?: number;
  readonly sections: readonly AgentRawReadViewSection[];
  readonly truncated: boolean;
} {
  const output: AgentRawReadViewSection[] = [];
  let remainingChars = Math.max(0, limits.maxChars);
  let truncated = sections.length > limits.maxSections;
  for (const item of sections.slice(0, limits.maxSections)) {
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
    const text = item.text.length > remainingChars ? item.text.slice(0, remainingChars) : item.text;
    if (text.length < item.text.length) {
      truncated = true;
    }
    output.push({ ...item, text });
    remainingChars -= text.length;
  }
  return {
    nextOffset: output.length,
    sections: output,
    truncated,
  };
}

function createRedactionTracker() {
  let emailCount = 0;
  let secretCount = 0;
  return {
    redact(value: string): string {
      let output = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, () => {
        emailCount += 1;
        return '[redacted-email]';
      });
      output = output.replace(
        /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)\b\s*[:=]\s*["']?([A-Za-z0-9._-]{6,})["']?/gi,
        (_match, key: string) => {
          secretCount += 1;
          return `${key}=[redacted-secret]`;
        },
      );
      return output;
    },
    summary(): RawReadViewRedaction[] {
      return [
        ...(emailCount > 0 ? [{ count: emailCount, kind: 'email' as const }] : []),
        ...(secretCount > 0 ? [{ count: secretCount, kind: 'secret' as const }] : []),
      ];
    },
  };
}

function actorHints(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [optionalString(record.name), optionalString(record.login), optionalString(record.email)]
    .filter((item): item is string => Boolean(item))
    .map((item) => `actor: ${item}`);
}

function rawDocumentFromRow(value: unknown): RawReadViewRawDocument {
  const row = requireRecord(value);
  const sourceType = optionalString(row.source_type);
  if (!isRawSourceType(sourceType)) {
    throw new RawReadViewError('Invalid raw read view row.');
  }
  return {
    canonicalUri: optionalString(row.canonical_uri),
    documentId: optionalString(row.document_id),
    projectSlug: requireString(row.project_slug),
    rawDocumentId: requireString(row.raw_document_id),
    sourceId: requireString(row.source_id),
    sourceType,
    storageUri: requireString(row.storage_uri),
    title: optionalString(row.title),
  };
}

function parseJson(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    throw new RawReadViewError('Raw document is not valid JSON for read view.');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RawReadViewError('Raw document contract mismatch for read view.');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RawReadViewError('Invalid raw read view row.');
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRawSourceType(value: unknown): value is RawSourceType {
  return value === 'drive' || value === 'github' || value === 'gmail' || value === 'web';
}

function requireNonEmptySections(
  sections: readonly AgentRawReadViewSection[],
): AgentRawReadViewSection[] {
  if (sections.length === 0) {
    throw new RawReadViewError('Raw document did not contain readable sections.');
  }
  return [...sections];
}

function encodeCursor(offset: number): string {
  return `section:${offset}`;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const match = /^section:(\d+)$/.exec(cursor);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

function splitParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}|(?<=[。.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}
