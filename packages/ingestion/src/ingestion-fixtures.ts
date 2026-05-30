import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SourceType = 'github' | 'web' | 'gmail' | 'drive';
export type ParsedDocumentType = 'issue' | 'pull_request' | 'web_page' | 'email' | 'drive_doc';

export interface RawDocumentContract {
  projectSlug: string;
  sourceType: SourceType;
  sourceId: string;
  sourceUri: string;
  storageUri: string;
  mimeType: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export interface ActorMention {
  displayName: string;
  email?: string;
  githubLogin?: string;
  role: 'author' | 'sender' | 'owner' | 'reviewer' | 'commenter';
}

export interface ParsedRelation {
  type: 'COMMENTED_ON' | 'REVIEWED' | 'LINKS_TO' | 'REPLY_TO' | 'SAME_AS_CANDIDATE';
  target: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedDocument {
  schemaVersion: 1;
  sourceType: SourceType;
  sourceId: string;
  docType: ParsedDocumentType;
  title: string;
  canonicalUri: string;
  occurredAt: string;
  bodyText: string;
  actors: ActorMention[];
  relations: ParsedRelation[];
  emailQuotes?: Array<{
    messageId: string;
    from: string;
    sentAt: string;
    bodyText: string;
    prevMessageId?: string;
  }>;
  metadata: Record<string, unknown>;
}

export interface IngestionFixtureCase {
  id: string;
  sourceType: SourceType;
  rawPath: string;
  snapshotPath: string;
  raw: RawDocumentContract;
}

interface GitHubRaw {
  kind: 'issue' | 'pull_request';
  repository: string;
  number: number;
  title: string;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string; name: string };
  comments?: Array<{ id: number; user: { login: string; name: string }; body: string }>;
  reviews?: Array<{ id: number; user: { login: string; name: string }; state: string }>;
}

interface GmailRaw {
  threadId: string;
  messageId: string;
  subject: string;
  from: { name: string; email: string };
  to: Array<{ name: string; email: string }>;
  sentAt: string;
  bodyText: string;
  quotedMessages: Array<{
    messageId: string;
    from: { name: string; email: string };
    sentAt: string;
    bodyText: string;
    prevMessageId?: string;
  }>;
}

interface DriveRaw {
  fileId: string;
  revisionId: string;
  title: string;
  mimeType: string;
  owners: Array<{ name: string; email: string }>;
  modifiedTime: string;
  webViewLink: string;
  bodyText: string;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesRoot = join(repoRoot, 'fixtures/ingestion');

export async function loadIngestionFixtureCases(): Promise<IngestionFixtureCase[]> {
  const manifestPath = join(fixturesRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as IngestionFixtureCase[];
  return manifest.map((fixtureCase) => validateRawFixtureCase(fixtureCase));
}

export function validateRawFixtureCase(fixtureCase: IngestionFixtureCase): IngestionFixtureCase {
  const expectedPrefix = `${fixtureCase.raw.projectSlug}/raw/${fixtureCase.sourceType}/`;
  if (!fixtureCase.raw.storageUri.startsWith(expectedPrefix)) {
    throw new Error(`Raw storageUri must start with ${expectedPrefix}: ${fixtureCase.id}`);
  }
  if (fixtureCase.raw.sourceType !== fixtureCase.sourceType) {
    throw new Error(`sourceType mismatch: ${fixtureCase.id}`);
  }
  if (fixtureCase.raw.sourceId.length < 3) {
    throw new Error(`sourceId is too short: ${fixtureCase.id}`);
  }
  if (!/^[a-f0-9]{64}$/.test(fixtureCase.raw.contentHash)) {
    throw new Error(`contentHash must be sha256 hex: ${fixtureCase.id}`);
  }
  return fixtureCase;
}

export async function parseRawFixture(fixtureCase: IngestionFixtureCase): Promise<ParsedDocument> {
  const rawText = await readFile(join(repoRoot, fixtureCase.rawPath), 'utf8');

  switch (fixtureCase.sourceType) {
    case 'github':
      return parseGitHub(fixtureCase, JSON.parse(rawText) as GitHubRaw);
    case 'web':
      return parseWeb(fixtureCase, rawText);
    case 'gmail':
      return parseGmail(fixtureCase, JSON.parse(rawText) as GmailRaw);
    case 'drive':
      return parseDrive(fixtureCase, JSON.parse(rawText) as DriveRaw);
  }
}

export function validateParsedDocument(parsed: ParsedDocument): ParsedDocument {
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported parsed schemaVersion: ${parsed.schemaVersion}`);
  }
  if (parsed.title.trim() === '') {
    throw new Error('Parsed document title is required');
  }
  if (parsed.bodyText.trim() === '') {
    throw new Error(`Parsed document bodyText is required: ${parsed.sourceId}`);
  }
  if (Number.isNaN(Date.parse(parsed.occurredAt))) {
    throw new Error(`Parsed document occurredAt must be ISO date: ${parsed.sourceId}`);
  }
  if (!parsed.canonicalUri.includes(':')) {
    throw new Error(`Parsed document canonicalUri must include a scheme: ${parsed.sourceId}`);
  }
  return parsed;
}

function parseGitHub(fixtureCase: IngestionFixtureCase, raw: GitHubRaw): ParsedDocument {
  const actors: ActorMention[] = [
    { displayName: raw.user.name, githubLogin: raw.user.login, role: 'author' },
  ];
  const relations: ParsedRelation[] = [];

  for (const comment of raw.comments ?? []) {
    actors.push({
      displayName: comment.user.name,
      githubLogin: comment.user.login,
      role: 'commenter',
    });
    relations.push({
      metadata: { commentId: comment.id },
      target: `${raw.repository}#${raw.number}`,
      type: 'COMMENTED_ON',
    });
  }

  for (const review of raw.reviews ?? []) {
    actors.push({
      displayName: review.user.name,
      githubLogin: review.user.login,
      role: 'reviewer',
    });
    relations.push({
      metadata: { reviewId: review.id, state: review.state },
      target: `${raw.repository}#${raw.number}`,
      type: 'REVIEWED',
    });
  }

  return validateParsedDocument({
    actors,
    bodyText: [raw.body, ...(raw.comments ?? []).map((comment) => comment.body)].join('\n\n'),
    canonicalUri: raw.html_url,
    docType: raw.kind,
    metadata: {
      repository: raw.repository,
      updatedAt: raw.updated_at,
    },
    occurredAt: raw.created_at,
    relations,
    schemaVersion: 1,
    sourceId: fixtureCase.raw.sourceId,
    sourceType: 'github',
    title: raw.title,
  });
}

function parseWeb(fixtureCase: IngestionFixtureCase, html: string): ParsedDocument {
  const title = textFromHtml(html.match(/<title>(?<title>.*?)<\/title>/is)?.groups?.title ?? '');
  const canonicalUri =
    html.match(/<link\s+rel="canonical"\s+href="(?<href>[^"]+)"/i)?.groups?.href ??
    fixtureCase.raw.sourceUri;
  const bodyText = textFromHtml(html.replace(/<script[\s\S]*?<\/script>/gi, ''));

  return validateParsedDocument({
    actors: [],
    bodyText,
    canonicalUri,
    docType: 'web_page',
    metadata: fixtureCase.raw.metadata,
    occurredAt: String(fixtureCase.raw.metadata.fetchedAt),
    relations: extractLinks(html).map((href) => ({ target: href, type: 'LINKS_TO' })),
    schemaVersion: 1,
    sourceId: fixtureCase.raw.sourceId,
    sourceType: 'web',
    title,
  });
}

function parseGmail(fixtureCase: IngestionFixtureCase, raw: GmailRaw): ParsedDocument {
  return validateParsedDocument({
    actors: [
      {
        displayName: raw.from.name,
        email: raw.from.email,
        role: 'sender',
      },
      ...raw.to.map((recipient) => ({
        displayName: recipient.name,
        email: recipient.email,
        role: 'commenter' as const,
      })),
    ],
    bodyText: raw.bodyText,
    canonicalUri: fixtureCase.raw.sourceUri,
    docType: 'email',
    emailQuotes: raw.quotedMessages.map((quote) => ({
      bodyText: quote.bodyText,
      from: `${quote.from.name} <${quote.from.email}>`,
      messageId: quote.messageId,
      prevMessageId: quote.prevMessageId,
      sentAt: quote.sentAt,
    })),
    metadata: {
      threadId: raw.threadId,
      toCount: raw.to.length,
    },
    occurredAt: raw.sentAt,
    relations: raw.quotedMessages.map((quote) => ({
      target: quote.messageId,
      type: 'REPLY_TO',
    })),
    schemaVersion: 1,
    sourceId: fixtureCase.raw.sourceId,
    sourceType: 'gmail',
    title: raw.subject,
  });
}

function parseDrive(fixtureCase: IngestionFixtureCase, raw: DriveRaw): ParsedDocument {
  return validateParsedDocument({
    actors: raw.owners.map((owner) => ({
      displayName: owner.name,
      email: owner.email,
      role: 'owner',
    })),
    bodyText: raw.bodyText,
    canonicalUri: raw.webViewLink,
    docType: 'drive_doc',
    metadata: {
      fileId: raw.fileId,
      mimeType: raw.mimeType,
      revisionId: raw.revisionId,
    },
    occurredAt: raw.modifiedTime,
    relations: [],
    schemaVersion: 1,
    sourceId: fixtureCase.raw.sourceId,
    sourceType: 'drive',
    title: raw.title,
  });
}

function textFromHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html: string): string[] {
  const links = [...html.matchAll(/<a\s+[^>]*href="(?<href>[^"]+)"/gi)].map(
    (match) => match.groups?.href ?? '',
  );
  return [...new Set(links.filter((href) => href.startsWith('http')))];
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
