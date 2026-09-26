import { portableKeywordTerms as buildTerms, type PortableKeywordTerm } from '@pufu-lens/retrieval';

export {
  type PortableKeywordTerm,
  portableKeywordTypoPattern,
} from '@pufu-lens/retrieval';

/** Renders the shared literal/regex term policy in the existing PostgreSQL LIKE/POSIX shape. */
export function portableKeywordTerms(query: string): PortableKeywordTerm[] {
  return buildTerms(query).map((term) => ({
    ...term,
    literal: term.literal ? `%${term.literal.replace(/[\\%_]/g, '\\$&')}%` : '',
    pattern: term.pattern.replaceAll('\\s', '[[:space:]]'),
  }));
}
