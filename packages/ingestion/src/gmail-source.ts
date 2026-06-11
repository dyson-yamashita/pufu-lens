import { createHash } from 'node:crypto';
import type {
  CollectDecision,
  CollectionObjectStorage,
  CollectionRepository,
  DataSourceRecord,
  RawDocumentInput,
} from './collection-pipeline.js';
import { normalizeSourceId } from './collection-pipeline.js';

export interface GmailListMessageResponse {
  id: string;
  threadId: string;
}

export interface GmailListResponse {
  messages?: GmailListMessageResponse[];
  nextPageToken?: string;
}

export interface GmailHeaderResponse {
  name: string;
  value: string;
}

export interface GmailMessagePartBodyResponse {
  data?: string;
}

export interface GmailMessagePartResponse {
  body?: GmailMessagePartBodyResponse;
  headers?: GmailHeaderResponse[];
  mimeType?: string;
  parts?: GmailMessagePartResponse[];
}

export interface GmailMessageResponse {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailMessagePartResponse;
  snippet?: string;
  threadId: string;
}

export interface GmailThreadResponse {
  id: string;
  messages?: GmailMessageResponse[];
}

export interface GmailRawDocument {
  bodyText: string;
  from: { email: string; name: string };
  messageId: string;
  quotedMessages: Array<{
    bodyText: string;
    from: { email: string; name: string };
    messageId: string;
    prevMessageId?: string;
    sentAt: string;
  }>;
  sentAt: string;
  subject: string;
  threadId: string;
  to: Array<{ email: string; name: string }>;
}

export type GmailFetcher = (input: { path: string; token?: string }) => Promise<unknown>;

export interface GmailCandidate {
  message: GmailListMessageResponse;
  query: string | undefined;
}

export interface GmailRawCandidate {
  body: string;
  raw: RawDocumentInput;
}

export interface CollectGmailSourceOptions {
  dryRun?: boolean;
  fetcher?: GmailFetcher;
  limit?: number;
  projectSlug: string;
  repository: CollectionRepository;
  storage: CollectionObjectStorage;
  token?: string;
}

export interface CollectGmailSourceResult {
  decisions: Array<{
    dataSourceId: string;
    decision: CollectDecision | 'would_collect' | 'would_skip_existing';
    error?: string;
    rawDocumentId?: string;
    sourceId: string;
    sourceType: 'gmail';
  }>;
  dryRun: boolean;
  failureCount: number;
  projectSlug: string;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_USER_AGENT = 'pufu-lens-gmail-collector/0.1';
const HEADER_NAMES = ['From', 'To', 'Subject', 'Date', 'Message-ID'];

export async function collectGmailSource(
  options: CollectGmailSourceOptions,
): Promise<CollectGmailSourceResult> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${options.projectSlug}`);
  }

  const fetcher = options.fetcher ?? fetchGmailJson;
  const dataSources = await options.repository.findDataSources(project.id, 'gmail');
  const decisions: CollectGmailSourceResult['decisions'] = [];
  let remainingLimit = options.limit;

  for (const dataSource of dataSources.filter((source) => source.enabled)) {
    if (remainingLimit !== undefined && remainingLimit <= 0) {
      break;
    }

    const candidates = await scanGmailDataSource({
      dataSource,
      fetcher,
      limit: remainingLimit,
      token: options.token,
    });

    for (const candidate of candidates) {
      if (remainingLimit !== undefined && remainingLimit <= 0) {
        break;
      }
      if (remainingLimit !== undefined) {
        remainingLimit -= 1;
      }

      let thread: GmailThreadResponse;
      try {
        thread = await fetchGmailThread({
          fetcher,
          threadId: candidate.message.threadId,
          token: options.token,
        });
      } catch (error) {
        const sanitizedError = sanitizeError(error);
        console.error(
          `Failed to fetch Gmail thread ${candidate.message.threadId}: ${sanitizedError}`,
        );
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'failed',
          error: sanitizedError,
          sourceId: normalizeSourceId(
            'gmail',
            `${candidate.message.threadId}:${candidate.message.id}`,
          ),
          sourceType: 'gmail',
        });
        continue;
      }
      const latestMessage = latestThreadMessage(thread);
      const sourceId = gmailMessageSourceId(latestMessage);
      const existing = await options.repository.lookupRawDocument({
        projectId: project.id,
        sourceId,
        sourceType: 'gmail',
      });

      if (existing) {
        if (!options.dryRun) {
          await options.repository.linkDataSource({
            dataSourceId: dataSource.id,
            matchReason: 'gmail-query-source-match',
            metadata: { query: candidate.query, threadId: latestMessage.threadId },
            projectId: project.id,
            rawDocumentId: existing.id,
          });

          if (existing.ingestStatus === 'failed') {
            await options.repository.queueCandidate({
              dataSourceId: dataSource.id,
              projectId: project.id,
              rawDocumentId: existing.id,
              targetId: sourceId,
              targetUri: gmailMessageUri(latestMessage),
            });
          }
        }

        decisions.push({
          dataSourceId: dataSource.id,
          decision: options.dryRun
            ? 'would_skip_existing'
            : existing.ingestStatus === 'failed'
              ? 'queued_failed'
              : 'skipped_existing',
          rawDocumentId: existing.id,
          sourceId,
          sourceType: 'gmail',
        });
        continue;
      }

      if (options.dryRun) {
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'would_collect',
          sourceId,
          sourceType: 'gmail',
        });
        continue;
      }

      let rawCandidate: GmailRawCandidate;
      try {
        rawCandidate = buildGmailRawCandidate({
          dataSource,
          projectId: project.id,
          projectSlug: project.slug,
          thread,
        });
      } catch (error) {
        const sanitizedError = sanitizeError(error);
        console.error(
          `Failed to build raw Gmail candidate for ${redactGmailUri(
            gmailMessageUri(latestMessage),
          )}: ${sanitizedError}`,
        );
        decisions.push({
          dataSourceId: dataSource.id,
          decision: 'failed',
          error: sanitizedError,
          sourceId,
          sourceType: 'gmail',
        });
        continue;
      }

      const sameHashCandidates = await options.repository.findSameHashCandidates({
        contentHash: rawCandidate.raw.contentHash,
        projectId: project.id,
        sourceType: 'gmail',
      });
      const stored = await options.storage.put(rawCandidate.raw.storageUri, rawCandidate.body, {
        contentType: rawCandidate.raw.mimeType,
      });
      const rawDocument = await options.repository.upsertRawDocument({
        ...rawCandidate.raw,
        metadata: {
          ...rawCandidate.raw.metadata,
          sameAsCandidateRawDocumentIds: sameHashCandidates.map((raw) => raw.id),
        },
        storageUri: stored.uri,
      });

      await options.repository.linkDataSource({
        dataSourceId: dataSource.id,
        matchReason: 'gmail-query-source-match',
        metadata: { query: candidate.query, threadId: latestMessage.threadId },
        projectId: project.id,
        rawDocumentId: rawDocument.id,
      });
      await options.repository.queueCandidate({
        dataSourceId: dataSource.id,
        projectId: project.id,
        rawDocumentId: rawDocument.id,
        targetId: sourceId,
        targetUri: rawCandidate.raw.sourceUri,
      });

      decisions.push({
        dataSourceId: dataSource.id,
        decision: 'collected',
        rawDocumentId: rawDocument.id,
        sourceId,
        sourceType: 'gmail',
      });
    }

    if (!options.dryRun) {
      await options.repository.markDataSourceChecked(dataSource.id);
    }
  }

  return {
    decisions,
    dryRun: options.dryRun ?? false,
    failureCount: countFailedDecisions(decisions),
    projectSlug: project.slug,
  };
}

function countFailedDecisions(decisions: CollectGmailSourceResult['decisions']): number {
  return decisions.filter((decision) => decision.decision === 'failed').length;
}

export async function scanGmailDataSource(input: {
  dataSource: DataSourceRecord;
  fetcher: GmailFetcher;
  limit?: number;
  token?: string;
}): Promise<GmailCandidate[]> {
  const { dataSource, fetcher, limit, token } = input;
  if (dataSource.sourceType !== 'gmail' || !dataSource.enabled) {
    return [];
  }

  const candidates: GmailCandidate[] = [];
  let pageToken: string | undefined;
  do {
    if (limit !== undefined && candidates.length >= limit) {
      break;
    }

    const query = gmailQuery(dataSource.config, dataSource.ingestWindow.since);
    const searchParams = new URLSearchParams({
      maxResults: String(gmailPageSize(limit)),
    });
    if (query) {
      searchParams.set('q', query);
    }
    for (const labelId of readLabelIds(dataSource.config)) {
      searchParams.append('labelIds', labelId);
    }
    if (readBoolean(dataSource.config.includeSpamTrash)) {
      searchParams.set('includeSpamTrash', 'true');
    }
    if (pageToken) {
      searchParams.set('pageToken', pageToken);
    }

    const response = validateGmailListResponse(
      await fetcher({ path: `/gmail/v1/users/me/messages?${searchParams.toString()}`, token }),
    );
    for (const message of response.messages ?? []) {
      if (limit !== undefined && candidates.length >= limit) {
        break;
      }
      if (!shouldIncludeMessage(message, dataSource.config)) {
        continue;
      }
      candidates.push({ message, query });
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  return candidates;
}

export function buildGmailRawCandidate(input: {
  dataSource: DataSourceRecord;
  projectId: string;
  projectSlug: string;
  thread: GmailThreadResponse;
}): GmailRawCandidate {
  const sortedMessages = sortedThreadMessages(input.thread);
  const latestMessage = sortedMessages.at(-1);
  if (!latestMessage) {
    throw new Error(`Gmail thread has no messages: ${input.thread.id}`);
  }

  const rawDocument = gmailRawDocument(latestMessage, sortedMessages.slice(0, -1));
  const body = `${JSON.stringify(rawDocument, null, 2)}\n`;
  const contentHash = sha256Hex(body);
  const fetchedAt = new Date().toISOString();
  const sourceId = gmailMessageSourceId(latestMessage);

  return {
    body,
    raw: {
      byteSize: Buffer.byteLength(body),
      contentHash,
      metadata: {
        dataSourceId: input.dataSource.id,
        fetchedAt,
        fromDomain: domainOf(rawDocument.from.email),
        labelIds: latestMessage.labelIds ?? [],
        messageId: rawDocument.messageId,
        quotedMessageCount: rawDocument.quotedMessages.length,
        sentAt: rawDocument.sentAt,
        subject: rawDocument.subject,
        threadId: rawDocument.threadId,
        toCount: rawDocument.to.length,
      },
      mimeType: 'application/json',
      projectId: input.projectId,
      sourceId,
      sourceType: 'gmail',
      sourceUri: gmailMessageUri(latestMessage),
      storageUri: `${input.projectSlug}/raw/gmail/${safeStorageSegment(sourceId)}.json`,
    },
  };
}

export async function fetchGmailJson(input: { path: string; token?: string }): Promise<unknown> {
  const url = new URL(input.path, 'https://gmail.googleapis.com');
  const response = await fetch(url.toString(), {
    headers: gmailHeaders(input.token),
  });
  if (!response.ok) {
    throw new Error(`Gmail API request failed with status ${response.status}: ${input.path}`);
  }
  return response.json();
}

async function fetchGmailThread(input: {
  fetcher: GmailFetcher;
  threadId: string;
  token?: string;
}): Promise<GmailThreadResponse> {
  const searchParams = new URLSearchParams({
    fields:
      'id,messages(id,threadId,labelIds,internalDate,snippet,payload(mimeType,headers(name,value),body(data),parts(mimeType,headers(name,value),body(data),parts(mimeType,headers(name,value),body(data))))',
    format: 'full',
  });
  for (const header of HEADER_NAMES) {
    searchParams.append('metadataHeaders', header);
  }
  return validateGmailThreadResponse(
    await input.fetcher({
      path: `/gmail/v1/users/me/threads/${encodeURIComponent(input.threadId)}?${searchParams.toString()}`,
      token: input.token,
    }),
  );
}

function gmailRawDocument(
  latestMessage: GmailMessageResponse,
  previousMessages: GmailMessageResponse[],
): GmailRawDocument {
  const latestHeaders = headerMap(latestMessage.payload?.headers);
  return {
    bodyText: messageBodyText(latestMessage),
    from: parseAddress(latestHeaders.get('from')),
    messageId: latestMessage.id,
    quotedMessages: previousMessages.map((message, index) => {
      const headers = headerMap(message.payload?.headers);
      return {
        bodyText: messageBodyText(message),
        from: parseAddress(headers.get('from')),
        messageId: message.id,
        ...(index > 0 ? { prevMessageId: previousMessages[index - 1]?.id } : {}),
        sentAt: messageSentAt(message, headers),
      };
    }),
    sentAt: messageSentAt(latestMessage, latestHeaders),
    subject: latestHeaders.get('subject') ?? '(no subject)',
    threadId: latestMessage.threadId,
    to: parseAddressList(latestHeaders.get('to')),
  };
}

function latestThreadMessage(thread: GmailThreadResponse): GmailMessageResponse {
  const latestMessage = sortedThreadMessages(thread).at(-1);
  if (!latestMessage) {
    throw new Error(`Gmail thread has no messages: ${thread.id}`);
  }
  return latestMessage;
}

function sortedThreadMessages(thread: GmailThreadResponse): GmailMessageResponse[] {
  return [...(thread.messages ?? [])].sort((left, right) => messageTime(left) - messageTime(right));
}

function gmailMessageSourceId(message: GmailMessageResponse): string {
  return normalizeSourceId('gmail', `${message.threadId}:${message.id}`);
}

function gmailMessageUri(message: GmailMessageResponse): string {
  return `gmail://${message.threadId}/${message.id}`;
}

function messageSentAt(message: GmailMessageResponse, headers: Map<string, string>): string {
  const headerDate = headers.get('date');
  if (headerDate && !Number.isNaN(Date.parse(headerDate))) {
    return new Date(headerDate).toISOString();
  }
  return new Date(messageTime(message)).toISOString();
}

function messageTime(message: GmailMessageResponse): number {
  const parsed = Number(message.internalDate);
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageBodyText(message: GmailMessageResponse): string {
  const plain = collectPartBodies(message.payload, 'text/plain').join('\n\n').trim();
  if (plain) {
    return plain;
  }
  const html = collectPartBodies(message.payload, 'text/html').join('\n\n').trim();
  return html ? textFromHtml(html) : (message.snippet ?? '').trim();
}

function collectPartBodies(part: GmailMessagePartResponse | undefined, mimeType: string): string[] {
  if (!part) {
    return [];
  }
  const bodies: string[] = [];
  if (part.mimeType === mimeType && part.body?.data) {
    bodies.push(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) {
    bodies.push(...collectPartBodies(child, mimeType));
  }
  return bodies;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function headerMap(headers: GmailHeaderResponse[] | undefined): Map<string, string> {
  return new Map((headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
}

function parseAddress(value: string | undefined): { email: string; name: string } {
  const trimmed = value?.trim() ?? '';
  const angleMatch = trimmed.match(/^(?<name>.*?)\s*<(?<email>[^>]+)>$/);
  if (angleMatch?.groups?.email) {
    const email = angleMatch.groups.email.trim();
    const name =
      (angleMatch.groups.name ?? '')
        .replace(/^"|"$/g, '')
        .replace(/\\(["\\])/g, '$1')
        .trim() || email;
    return { email, name };
  }
  if (trimmed.includes('@')) {
    return { email: trimmed, name: trimmed };
  }
  return { email: '', name: trimmed || 'Unknown Sender' };
}

function parseAddressList(value: string | undefined): Array<{ email: string; name: string }> {
  return (value ?? '')
    .split(/,(?=(?:(?:[^"\\]|\\.)*"(?:[^"\\]|\\.)*")*(?:[^"\\]|\\.)*$)/)
    .map((item) => parseAddress(item))
    .filter((address) => address.email || address.name !== 'Unknown Sender');
}

function gmailHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'user-agent': DEFAULT_USER_AGENT,
  };
}

function gmailPageSize(limit: number | undefined): number {
  const requested = Number.isFinite(limit) ? Number(limit) : DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(requested, DEFAULT_PAGE_SIZE));
}

function gmailQuery(config: Record<string, unknown>, since: unknown): string | undefined {
  const parts = [...readSingleString(config.query), ...readSingleString(config.q)];
  if (typeof since === 'string' && !Number.isNaN(Date.parse(since))) {
    parts.push(`after:${Math.floor(Date.parse(since) / 1000)}`);
  }
  return (
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ') || undefined
  );
}

function readLabelIds(config: Record<string, unknown>): string[] {
  return [...readStringArray(config.labelIds), ...readStringArray(config.labels)]
    .map((labelId) => labelId.trim())
    .filter(Boolean);
}

function shouldIncludeMessage(
  message: GmailListMessageResponse,
  config: Record<string, unknown>,
): boolean {
  const messageIds = readStringArray(config.messageIds);
  const threadIds = readStringArray(config.threadIds);
  return (
    (messageIds.length === 0 || messageIds.includes(message.id)) &&
    (threadIds.length === 0 || threadIds.includes(message.threadId))
  );
}

function validateGmailListResponse(value: unknown): GmailListResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Gmail messages response must be an object.');
  }
  const response = value as Record<string, unknown>;
  return {
    messages:
      response.messages === undefined
        ? undefined
        : validateArray(response.messages, 'Gmail messages').map(validateGmailListMessage),
    nextPageToken: readString(response.nextPageToken),
  };
}

function validateGmailListMessage(value: unknown): GmailListMessageResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Gmail message list item must be an object.');
  }
  const message = value as Record<string, unknown>;
  return {
    id: requiredString(message.id, 'message.id'),
    threadId: requiredString(message.threadId, 'message.threadId'),
  };
}

function validateGmailThreadResponse(value: unknown): GmailThreadResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Gmail thread response must be an object.');
  }
  const thread = value as Record<string, unknown>;
  return {
    id: requiredString(thread.id, 'thread.id'),
    messages:
      thread.messages === undefined
        ? undefined
        : validateArray(thread.messages, 'Gmail thread messages').map(validateGmailMessage),
  };
}

function validateGmailMessage(value: unknown): GmailMessageResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Gmail message must be an object.');
  }
  const message = value as Record<string, unknown>;
  return {
    id: requiredString(message.id, 'message.id'),
    internalDate: readString(message.internalDate),
    labelIds: readStringArray(message.labelIds),
    payload: validatePart(message.payload),
    snippet: readString(message.snippet),
    threadId: requiredString(message.threadId, 'message.threadId'),
  };
}

function validatePart(value: unknown): GmailMessagePartResponse | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    throw new Error('Gmail message payload must be an object.');
  }
  const part = value as Record<string, unknown>;
  return {
    body: validatePartBody(part.body),
    headers:
      part.headers === undefined
        ? undefined
        : validateArray(part.headers, 'Gmail headers').map(validateHeader),
    mimeType: readString(part.mimeType),
    parts:
      part.parts === undefined
        ? undefined
        : validateArray(part.parts, 'Gmail message parts').map(validateRequiredPart),
  };
}

function validateRequiredPart(value: unknown): GmailMessagePartResponse {
  const part = validatePart(value);
  if (!part) {
    throw new Error('Gmail message part must be an object.');
  }
  return part;
}

function validatePartBody(value: unknown): GmailMessagePartBodyResponse | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    throw new Error('Gmail message part body must be an object.');
  }
  const body = value as Record<string, unknown>;
  return { data: readString(body.data) };
}

function validateHeader(value: unknown): GmailHeaderResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Gmail header must be an object.');
  }
  const header = value as Record<string, unknown>;
  return {
    name: requiredString(header.name, 'header.name'),
    value: requiredString(header.value, 'header.value'),
  };
}

function validateArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

function textFromHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:[^"'>]|"[^"]*"|'[^']*')*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(apos|#39|#x27);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function domainOf(email: string): string | undefined {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain || undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readSingleString(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Gmail response field ${field} must be a string.`);
  }
  return value;
}

function safeStorageSegment(value: string): string {
  const hash = sha256Hex(value).slice(0, 12);
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 107);
  return clean ? `${clean}-${hash}` : hash;
}

function redactGmailUri(value: string): string {
  return value.replace(/gmail:\/\/([^/]+)\/(.+)/, 'gmail://$1/<message>');
}

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : String(error);
  return message
    .replace(/(token|secret|api[_-]?key)=\S+/gi, '$1=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>')
    .slice(0, 500);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
