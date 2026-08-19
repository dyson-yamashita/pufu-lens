import { createHash } from 'node:crypto';
import type {
  CollectionObjectStorage,
  CollectionRepository,
  DataSourceRecord,
  RawDocumentInput,
} from './collection-pipeline.js';

interface XUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}
interface XPost {
  readonly id: string;
  readonly text: string;
  readonly created_at: string;
  readonly conversation_id?: string;
}
interface XResponse<T> {
  readonly data?: T;
  readonly meta?: { readonly next_token?: string };
}

export interface XSyncWindow {
  readonly endTime: string;
  readonly startTime?: string;
}

/** Resolves the UTC API window: initial sync reads available history through yesterday; later runs read yesterday only. */
export function resolveXSyncWindow(now: Date, initial: boolean): XSyncWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  return initial
    ? { endTime: today.toISOString() }
    : { endTime: today.toISOString(), startTime: yesterday.toISOString() };
}

export interface CollectXSourceOptions {
  readonly dataSourceId?: string;
  readonly fetcher?: typeof fetch;
  readonly limit?: number;
  readonly now?: Date;
  readonly projectSlug: string;
  readonly repository: CollectionRepository;
  readonly storage: CollectionObjectStorage;
  readonly token: string;
}

/** Collects posts for configured X usernames while excluding the current UTC day. */
export async function collectXSource(
  options: CollectXSourceOptions,
): Promise<{ collected: number }> {
  const project = await options.repository.lookupProjectBySlug(options.projectSlug);
  if (!project) throw new Error(`Project not found: ${options.projectSlug}`);
  const sources = await options.repository.findDataSources(project.id, 'x', options.dataSourceId);
  let collected = 0;
  for (const source of sources) {
    const accounts = readAccounts(source);
    const window = resolveXSyncWindow(
      options.now ?? new Date(),
      source.lastSyncSucceededAt === null,
    );
    for (const account of accounts) {
      const user = await fetchX<XUser>(
        `https://api.x.com/2/users/by/username/${encodeURIComponent(account)}`,
        options.token,
        options.fetcher,
      );
      const params = new URLSearchParams({
        end_time: window.endTime,
        exclude: 'retweets,replies',
        max_results: String(Math.min(100, options.limit ?? 100)),
        'tweet.fields': 'created_at,conversation_id',
      });
      if (window.startTime) params.set('start_time', window.startTime);
      let nextToken: string | undefined;
      let remaining = options.limit ?? 3_200;
      do {
        if (nextToken) params.set('pagination_token', nextToken);
        const page = await fetchXPage<XPost[]>(
          `https://api.x.com/2/users/${encodeURIComponent(user.id)}/tweets?${params}`,
          options.token,
          options.fetcher,
        );
        for (const post of page.data.slice(0, remaining)) {
          const rawText = JSON.stringify({ ...post, author: user });
          const hash = createHash('sha256').update(rawText).digest('hex');
          const sourceId = `x:post:${post.id}`;
          const storageUri = `${project.slug}/raw/x/${post.id}.json`;
          const stored = await options.storage.put(storageUri, rawText, {
            contentType: 'application/json',
          });
          const raw: RawDocumentInput = {
            byteSize: Buffer.byteLength(rawText),
            contentHash: hash,
            logicalSourceId: sourceId,
            metadata: { account: user.username },
            mimeType: 'application/json',
            projectId: project.id,
            sourceId,
            sourceType: 'x',
            sourceUri: `https://x.com/${user.username}/status/${post.id}`,
            sourceVersion: post.created_at,
            storageUri: stored.uri,
          };
          const result = await options.repository.upsertRawDocument(raw);
          await options.repository.linkDataSource({
            dataSourceId: source.id,
            matchReason: 'x-account-match',
            metadata: { account },
            projectId: project.id,
            rawDocumentId: result.rawDocument.id,
          });
          if (result.inserted || result.rawDocument.ingestStatus === 'failed') {
            await options.repository.queueCandidate({
              dataSourceId: source.id,
              projectId: project.id,
              rawDocumentId: result.rawDocument.id,
              targetId: sourceId,
              targetUri: raw.sourceUri,
            });
            collected += 1;
          }
          remaining -= 1;
        }
        nextToken = page.meta?.next_token;
      } while (nextToken && remaining > 0);
    }
    await options.repository.markDataSourceChecked(source.id);
    await options.repository.completeDataSourceSync({
      dataSourceId: source.id,
      projectId: project.id,
      syncCursor: { ...window, mode: 'x-daily-v1' },
    });
  }
  return { collected };
}

function readAccounts(source: DataSourceRecord): string[] {
  const accounts = source.config.accounts;
  if (
    !Array.isArray(accounts) ||
    accounts.length === 0 ||
    accounts.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`X data source ${source.id} requires a non-empty accounts array.`);
  }
  return accounts.map((item) => item.replace(/^@/, '').trim()).filter(Boolean);
}

async function fetchX<T>(url: string, token: string, fetcher = fetch): Promise<T> {
  return (await fetchXPage<T>(url, token, fetcher)).data;
}

async function fetchXPage<T>(
  url: string,
  token: string,
  fetcher = fetch,
): Promise<{ data: T; meta?: XResponse<T>['meta'] }> {
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`X API request failed (${response.status}).`);
  const body = (await response.json()) as XResponse<T>;
  if (body.data === undefined) throw new Error('X API response did not include data.');
  return { data: body.data, meta: body.meta };
}
