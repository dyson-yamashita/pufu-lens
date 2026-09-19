/** Synthetic Step 3D holdout dimensions; it contains no production text or identifiers. */
export interface KeywordHoldoutCase {
  readonly category: string;
  readonly expectedChunkIndexes: readonly number[];
  readonly id: string;
  readonly knownFailure?: 'portable_numeric_false_positive';
  readonly query: string;
}

/**
 * Keeps boundary queries explicit so PGroonga baseline and portable candidate results are compared
 * without changing the v1 corpus or weakening its judgments.
 */
export const keywordHoldoutCases: readonly KeywordHoldoutCase[] = [
  { category: 'japanese-short', expectedChunkIndexes: [0], id: 'ja-short', query: '猫' },
  { category: 'japanese-typo', expectedChunkIndexes: [1], id: 'ja-typo', query: 'ガラズ' },
  { category: 'combining-unicode', expectedChunkIndexes: [1], id: 'combining', query: 'ガラス' },
  {
    category: 'numeric-identifier',
    expectedChunkIndexes: [3],
    id: 'numeric-exact',
    query: '31415',
  },
  {
    category: 'numeric-negative',
    expectedChunkIndexes: [],
    id: 'numeric-near-miss',
    knownFailure: 'portable_numeric_false_positive',
    query: '31417',
  },
  { category: 'identifier', expectedChunkIndexes: [5], id: 'identifier-api', query: 'API' },
  {
    category: 'negative-multiword',
    expectedChunkIndexes: [],
    id: 'negative-multiword',
    query: 'absent OR blackhole',
  },
  {
    category: 'negative-word',
    expectedChunkIndexes: [],
    id: 'negative-word',
    query: 'not ActivityPub',
  },
  { category: 'unicode-width', expectedChunkIndexes: [5], id: 'unicode-width', query: 'ＡＰＩ' },
  { category: 'escaping-percent', expectedChunkIndexes: [2], id: 'escape-percent', query: '%' },
  {
    category: 'escaping-underscore',
    expectedChunkIndexes: [2],
    id: 'escape-underscore',
    query: '_',
  },
  {
    category: 'escaping-backslash',
    expectedChunkIndexes: [2],
    id: 'escape-backslash',
    query: '\\',
  },
  { category: 'emoji', expectedChunkIndexes: [1], id: 'emoji', query: '🧑‍💻' },
  { category: 'injection', expectedChunkIndexes: [], id: 'injection', query: "' OR 1=1 --" },
];
