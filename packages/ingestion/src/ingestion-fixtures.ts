import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeterministicTopicExtractionAgent,
  type TopicExtractionAgent,
} from './topic-extraction-agent.js';

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

export interface ParsedTopic {
  topicType: 'keyword';
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
  topics?: ParsedTopic[];
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

export interface ParseRawContentOptions {
  topicExtractionAgent?: TopicExtractionAgent;
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
  to?: Array<{ name: string; email: string }> | null;
  sentAt: string;
  bodyText: string;
  quotedMessages?: Array<{
    messageId: string;
    from: { name: string; email: string };
    sentAt: string;
    bodyText: string;
    prevMessageId?: string;
  }> | null;
}

interface DriveRaw {
  fileId: string;
  revisionId: string;
  title: string;
  mimeType: string;
  owners?: Array<{ name: string; email: string }> | null;
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

export async function parseRawFixture(
  fixtureCase: IngestionFixtureCase,
  options: ParseRawContentOptions = {},
): Promise<ParsedDocument> {
  const rawText = await readFile(join(repoRoot, fixtureCase.rawPath), 'utf8');
  return parseRawContent(fixtureCase, rawText, options);
}

export async function parseRawContent(
  fixtureCase: Pick<IngestionFixtureCase, 'raw' | 'sourceType'>,
  rawText: string,
  options: ParseRawContentOptions = {},
): Promise<ParsedDocument> {
  switch (fixtureCase.sourceType) {
    case 'github':
      return parseGitHub(fixtureCase, JSON.parse(rawText) as GitHubRaw);
    case 'web':
      return parseWeb(fixtureCase, rawText, options.topicExtractionAgent);
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
  if (Number.isNaN(Date.parse(parsed.occurredAt))) {
    throw new Error(`Parsed document occurredAt must be ISO date: ${parsed.sourceId}`);
  }
  if (!parsed.canonicalUri.includes(':')) {
    throw new Error(`Parsed document canonicalUri must include a scheme: ${parsed.sourceId}`);
  }
  for (const topic of parsed.topics ?? []) {
    if (!topic || typeof topic !== 'object' || topic.topicType !== 'keyword') {
      throw new Error(`Parsed document topicType must be 'keyword': ${parsed.sourceId}`);
    }
    if (typeof topic.target !== 'string' || topic.target.trim() === '') {
      throw new Error(`Parsed document topic target is required: ${parsed.sourceId}`);
    }
  }
  return parsed;
}

function parseGitHub(
  fixtureCase: Pick<IngestionFixtureCase, 'raw' | 'sourceType'>,
  raw: GitHubRaw,
): ParsedDocument {
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

async function parseWeb(
  fixtureCase: Pick<IngestionFixtureCase, 'raw' | 'sourceType'>,
  html: string,
  topicExtractionAgent: TopicExtractionAgent = createDeterministicTopicExtractionAgent(),
): Promise<ParsedDocument> {
  const title = textFromHtml(firstElementText(html, 'title') ?? '');
  const canonicalLink = htmlTags(html, 'link').find(
    (link) => getHtmlAttribute(link, 'rel')?.toLowerCase() === 'canonical',
  );
  const canonicalUri =
    canonicalLink === undefined
      ? fixtureCase.raw.sourceUri
      : (getHtmlAttribute(canonicalLink, 'href') ?? fixtureCase.raw.sourceUri);
  const bodyText = textFromHtml(html);
  const publishedAt = extractPublishedAt(html) ?? String(fixtureCase.raw.metadata.fetchedAt);

  return validateParsedDocument({
    actors: [],
    bodyText,
    canonicalUri,
    docType: 'web_page',
    metadata: fixtureCase.raw.metadata,
    occurredAt: publishedAt,
    relations: [],
    schemaVersion: 1,
    sourceId: fixtureCase.raw.sourceId,
    sourceType: 'web',
    title,
    topics: await topicExtractionAgent.extractTopics({ bodyText, canonicalUri, html, title }),
  });
}

function extractPublishedAt(html: string): string | undefined {
  return (
    extractJsonLdPublishedAt(html) ??
    extractMetaDate(html, ['article:published_time', 'datePublished', 'date']) ??
    extractTimeDateTime(html)
  );
}

function extractJsonLdPublishedAt(html: string): string | undefined {
  for (const script of htmlElements(html, 'script')) {
    if (getHtmlAttribute(script.tag, 'type')?.toLowerCase() !== 'application/ld+json') {
      continue;
    }
    const jsonText = script.text.trim();
    if (!jsonText) {
      continue;
    }
    try {
      const value = JSON.parse(jsonText) as unknown;
      const date = findJsonLdDatePublished(value);
      if (date) {
        return date;
      }
    } catch {
      // Ignore malformed or framework-injected JSON-LD and try the next date source.
    }
  }
  return undefined;
}

function findJsonLdDatePublished(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const date = findJsonLdDatePublished(item);
      if (date) {
        return date;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = parseIsoDateValue(value.datePublished);
  if (direct) {
    return direct;
  }
  const graph = value['@graph'];
  if (Array.isArray(graph)) {
    for (const item of graph) {
      const date = findJsonLdDatePublished(item);
      if (date) {
        return date;
      }
    }
  }
  return undefined;
}

function extractMetaDate(html: string, names: readonly string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of htmlTags(html, 'meta')) {
    const key =
      getHtmlAttribute(tag, 'property')?.toLowerCase() ??
      getHtmlAttribute(tag, 'name')?.toLowerCase();
    if (!key || !wanted.has(key)) {
      continue;
    }
    const parsed = parseIsoDateValue(getHtmlAttribute(tag, 'content'));
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function extractTimeDateTime(html: string): string | undefined {
  for (const time of htmlTags(html, 'time')) {
    const parsed = parseIsoDateValue(getHtmlAttribute(time, 'datetime'));
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function parseIsoDateValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseGmail(
  fixtureCase: Pick<IngestionFixtureCase, 'raw' | 'sourceType'>,
  raw: GmailRaw,
): ParsedDocument {
  const recipients = raw.to ?? [];
  const quotedMessages = raw.quotedMessages ?? [];

  return validateParsedDocument({
    actors: [
      {
        displayName: raw.from.name,
        email: raw.from.email,
        role: 'sender',
      },
      ...recipients.map((recipient) => ({
        displayName: recipient.name,
        email: recipient.email,
        role: 'commenter' as const,
      })),
    ],
    bodyText: raw.bodyText,
    canonicalUri: fixtureCase.raw.sourceUri,
    docType: 'email',
    emailQuotes: quotedMessages.map((quote) => ({
      bodyText: quote.bodyText,
      from: `${quote.from.name} <${quote.from.email}>`,
      messageId: quote.messageId,
      prevMessageId: quote.prevMessageId,
      sentAt: quote.sentAt,
    })),
    metadata: {
      threadId: raw.threadId,
      toCount: recipients.length,
    },
    occurredAt: raw.sentAt,
    relations: quotedMessages.map((quote) => ({
      target: quote.messageId,
      type: 'REPLY_TO',
    })),
    schemaVersion: 1,
    sourceId: fixtureCase.raw.sourceId,
    sourceType: 'gmail',
    title: raw.subject,
  });
}

function parseDrive(
  fixtureCase: Pick<IngestionFixtureCase, 'raw' | 'sourceType'>,
  raw: DriveRaw,
): ParsedDocument {
  return validateParsedDocument({
    actors: (raw.owners ?? []).map((owner) => ({
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
  return normalizeWhitespace(htmlEntityDecode(stripHtmlTags(value)));
}

function stripHtmlTags(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char !== '<') {
      output += char;
      continue;
    }
    const tagEnd = findHtmlTagEnd(value, index + 1);
    if (tagEnd === -1) {
      output += char;
      continue;
    }
    const tagName = readHtmlTagName(value, index + 1);
    index =
      tagName === 'script' || tagName === 'style'
        ? findClosingTagEnd(value, tagName, tagEnd + 1)
        : tagEnd;
    output += ' ';
  }
  return output;
}

function findHtmlTagEnd(value: string, startIndex: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') {
      return index;
    }
  }
  return -1;
}

function htmlEntityDecode(value: string): string {
  const entities = new Map([
    ['nbsp', ' '],
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
    ['#39', "'"],
  ]);
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charAt(index) !== '&') {
      output += value.charAt(index);
      continue;
    }
    const semicolon = value.indexOf(';', index + 1);
    if (semicolon < 0 || semicolon - index > 12) {
      output += value.charAt(index);
      continue;
    }
    const decoded = entities.get(value.slice(index + 1, semicolon).toLowerCase());
    output += decoded ?? value.slice(index, semicolon + 1);
    index = semicolon;
  }
  return output;
}

function getHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const wanted = attributeName.toLowerCase();
  let index = 0;
  while (index < tag.length) {
    while (index < tag.length && tag.charAt(index).trim() !== '') {
      index += 1;
    }
    while (index < tag.length && tag.charAt(index).trim() === '') {
      index += 1;
    }
    const nameStart = index;
    while (index < tag.length && isHtmlAttributeNameChar(tag.charAt(index))) {
      index += 1;
    }
    const name = tag.slice(nameStart, index).toLowerCase();
    while (index < tag.length && tag.charAt(index).trim() === '') {
      index += 1;
    }
    if (tag.charAt(index) !== '=') {
      continue;
    }
    index += 1;
    while (index < tag.length && tag.charAt(index).trim() === '') {
      index += 1;
    }
    const value = readHtmlAttributeValue(tag, index);
    if (name === wanted) {
      return value.value;
    }
    index = value.end;
  }
  return undefined;
}

function firstElementText(html: string, tagName: string): string | undefined {
  return htmlElements(html, tagName)[0]?.text;
}

function htmlElements(html: string, tagName: string): { tag: string; text: string }[] {
  const elements: { tag: string; text: string }[] = [];
  const wanted = tagName.toLowerCase();
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== '<' || html[index + 1] === '/') {
      continue;
    }
    if (readHtmlTagName(html, index + 1) !== wanted) {
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, index + 1);
    if (tagEnd < 0) {
      continue;
    }
    const tag = html.slice(index, tagEnd + 1);
    const contentStart = tagEnd + 1;
    const contentEnd = findClosingTagStart(html, tagName, contentStart);
    if (contentEnd < 0) {
      continue;
    }
    elements.push({ tag, text: html.slice(contentStart, contentEnd) });
    index = contentEnd;
  }
  return elements;
}

function htmlTags(html: string, tagName: string): string[] {
  const tags: string[] = [];
  const wanted = tagName.toLowerCase();
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== '<' || html[index + 1] === '/') {
      continue;
    }
    if (readHtmlTagName(html, index + 1) !== wanted) {
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, index + 1);
    if (tagEnd < 0) {
      continue;
    }
    tags.push(html.slice(index, tagEnd + 1));
    index = tagEnd;
  }
  return tags;
}

function readHtmlTagName(value: string, startIndex: number): string {
  let index = startIndex;
  if (value.charAt(index) === '/') {
    index += 1;
  }
  while (index < value.length && value.charAt(index).trim() === '') {
    index += 1;
  }
  let name = '';
  while (index < value.length) {
    const char = value.charAt(index).toLowerCase();
    if (char < 'a' || char > 'z') {
      break;
    }
    name += char;
    index += 1;
  }
  return name;
}

function findClosingTagStart(value: string, tagName: string, startIndex: number): number {
  return value.toLowerCase().indexOf(`</${tagName}`, startIndex);
}

function findClosingTagEnd(value: string, tagName: string, startIndex: number): number {
  const closeStart = findClosingTagStart(value, tagName, startIndex);
  if (closeStart < 0) {
    return value.length - 1;
  }
  const closeEnd = findHtmlTagEnd(value, closeStart + tagName.length + 2);
  return closeEnd < 0 ? value.length - 1 : closeEnd;
}

function isHtmlAttributeNameChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '-' ||
    char === ':' ||
    char === '_'
  );
}

function readHtmlAttributeValue(tag: string, startIndex: number): { end: number; value: string } {
  const quote = tag[startIndex];
  if (quote === '"' || quote === "'") {
    const end = tag.indexOf(quote, startIndex + 1);
    return end < 0
      ? { end: tag.length, value: tag.slice(startIndex + 1) }
      : { end: end + 1, value: tag.slice(startIndex + 1, end) };
  }
  let end = startIndex;
  while (end < tag.length && tag.charAt(end).trim() !== '' && tag.charAt(end) !== '>') {
    end += 1;
  }
  return { end, value: tag.slice(startIndex, end) };
}

function normalizeWhitespace(value: string): string {
  let output = '';
  let pendingSpace = false;
  for (const char of value.trim()) {
    if (char.trim() === '') {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output.length > 0) {
      output += ' ';
    }
    output += char;
    pendingSpace = false;
  }
  return output;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
