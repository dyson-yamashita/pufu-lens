export interface PortableKeywordTerm {
  /** Empty disables substring matching when an exact label/number association is required. */
  readonly literal: string;
  /** Empty disables n-gram approximation for numeric phrases and literal punctuation. */
  readonly approximate: string;
  /** Safe unanchored ECMAScript regex source; adapters render other regex dialects at their boundary. */
  readonly pattern: string;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds bounded spelling variants without a dictionary or fixture-specific corrections.
 * Latin words allow one adjacent transposition; Japanese terms allow one moved character.
 * Katakana terms additionally allow one Katakana substitution. Terms outside 3..12 code points
 * keep the provider's n-gram path only. Regex syntax from input is always escaped.
 */
export function portableKeywordTypoPattern(term: string): string {
  const chars = [...term];
  if (chars.length < 3 || chars.length > 12) return '';
  const latin = /^[a-z]+$/.test(term);
  const japanese = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(term);
  if (!latin && !japanese) return '';
  const variants = new Set<string>();
  for (let from = 0; from < chars.length; from++) {
    for (let to = 0; to < chars.length; to++) {
      if (from === to || (latin && to !== from + 1)) continue;
      const copy = [...chars];
      const [moved] = copy.splice(from, 1);
      if (moved === undefined) continue;
      copy.splice(to, 0, moved);
      const variant = copy.join('');
      if (variant !== term) variants.add(escapeRegex(variant));
    }
  }
  if (/^[ァ-ヶー]+$/.test(term)) {
    for (let index = 0; index < chars.length; index++) {
      variants.add(
        `${escapeRegex(chars.slice(0, index).join(''))}[ァ-ヶー]${escapeRegex(chars.slice(index + 1).join(''))}`,
      );
    }
  }
  return variants.size ? `(${[...variants].join('|')})` : '';
}

/**
 * Requires every whitespace-delimited term after normalization. Punctuation stays literal.
 * An ASCII word immediately followed by digits is one label/number phrase, preserving the
 * association and repeated numbers (e.g. release 12 build 34); bare numbers remain unordered.
 */
export function portableKeywordTerms(query: string): PortableKeywordTerm[] {
  const words = query.split(/\s+/u).filter(Boolean);
  const terms: PortableKeywordTerm[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === undefined) continue;
    const next = words[index + 1];
    if (/^[a-z]+$/.test(word) && next !== undefined && /^[0-9]+$/.test(next)) {
      const typo = portableKeywordTypoPattern(word);
      const label = typo ? `(${escapeRegex(word)}|${typo})` : escapeRegex(word);
      terms.push({
        literal: '',
        approximate: '',
        pattern: `(^|[^a-z0-9_])${label}\\s+${next}([^0-9]|$)`,
      });
      index++;
    } else {
      const plain = /^[\p{L}\p{M}]+$/u.test(word);
      terms.push({
        literal: word,
        approximate: plain ? word : '',
        pattern: plain ? portableKeywordTypoPattern(word) : '',
      });
    }
  }
  return terms;
}
