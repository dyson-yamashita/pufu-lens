import type postgres from 'postgres';
import type { ChatSource } from './chat.ts';

interface GitHubReference {
  readonly kind: 'issue' | 'pull_request';
  readonly number: string;
}

/** Extracts one explicit PR/Issue number; ambiguous, URL-qualified and multiple references use normal search. */
export function parseChatGitHubReference(question: string): GitHubReference | undefined {
  const text = question.normalize('NFKC');
  if (/https?:\/\/|[\w.-]+\/[\w.-]+#/i.test(text)) return undefined;
  const matches = [
    ...text.matchAll(/(?<![\w])(?:PR|pull request|Issue)\s*#\s*([1-9][0-9]{0,9})(?![\w])/gi),
  ];
  if (matches.length !== 1 || [...text.matchAll(/#\s*[0-9]+/g)].length !== 1) return undefined;
  const match = matches[0];
  if (!match?.[1]) return undefined;
  return { kind: /^issue/i.test(match[0]) ? 'issue' : 'pull_request', number: match[1] };
}

/** Matches only typed GitHub canonical URLs, never title/summary mentions or numeric substrings. */
export function matchesChatGitHubReference(question: string, source: ChatSource): boolean {
  const reference = parseChatGitHubReference(question);
  if (!reference || source.docType !== reference.kind) return false;
  const path = reference.kind === 'issue' ? 'issues' : 'pull';
  return new RegExp(
    `^https://github\\.com/[^/?#]+/[^/?#]+/${path}/${reference.number}/?$`,
    'i',
  ).test(source.canonicalUri);
}

/** Looks up an unambiguous canonical GitHub document in the authorized project, with bound input and validated rows. */
export async function findChatGitHubReferenceDocumentIds(
  sql: postgres.Sql,
  input: { readonly question: string; readonly projectId: string },
): Promise<string[]> {
  const reference = parseChatGitHubReference(input.question);
  if (!reference) return [];
  const path = reference.kind === 'issue' ? 'issues' : 'pull';
  const pattern = `^https://github[.]com/[^/?#]+/[^/?#]+/${path}/${reference.number}/?$`;
  const rows: readonly unknown[] = await sql`
    SELECT d.id::text AS document_id
    FROM public.documents d
    WHERE d.project_id = ${input.projectId}
      AND d.doc_type = ${reference.kind}
      AND d.canonical_uri ~* ${pattern}
    ORDER BY d.id
    LIMIT 2
  `;
  const ids = rows.map((row) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('document_id' in row) ||
      typeof row.document_id !== 'string' ||
      !row.document_id.trim()
    ) {
      throw new Error('Invalid referenced document row.');
    }
    return row.document_id;
  });
  return ids.length === 1 ? ids : [];
}

/** Reserves a single explicit reference ahead of similarity results without discarding other evidence. */
export function prioritizeChatGitHubReference(
  question: string,
  sources: readonly ChatSource[],
): ChatSource[] {
  const matches = sources.filter((source) => matchesChatGitHubReference(question, source));
  if (matches.length !== 1) return [...sources];
  return [...matches, ...sources.filter((source) => source.documentId !== matches[0]?.documentId)];
}
