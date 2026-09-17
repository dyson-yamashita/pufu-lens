/** Synthetic, versioned judgments; no production records or personal data are used. */
export interface KeywordEvalCase {
  readonly id: string;
  readonly category: string;
  readonly query: string;
  readonly projectId: string;
  readonly grades: Readonly<Record<string, number>>;
  readonly required?: readonly string[];
  readonly reject?: boolean;
}

export const keywordCorpus: {
  readonly version: string;
  readonly k: number;
  readonly maxQueryLength: number;
  readonly chunks: readonly {
    readonly id: string;
    readonly documentId: string;
    readonly projectId: string;
    readonly content: string;
  }[];
  readonly cases: readonly KeywordEvalCase[];
} = {
  version: 'keyword-synthetic-v1',
  k: 20,
  maxQueryLength: 1000,
  chunks: [
    {
      id: 'c01',
      documentId: 'd01',
      projectId: 'alpha',
      content: '星舟計画の仕様変更。検索の設計と移行手順をまとめる。',
    },
    {
      id: 'c02',
      documentId: 'd02',
      projectId: 'alpha',
      content: '星舟計画の仕様変更レビュー。検索の設計を再確認した。',
    },
    {
      id: 'c03',
      documentId: 'd03',
      projectId: 'alpha',
      content: '架空担当者の空野テストが星舟計画の品質評価を担当する。',
    },
    {
      id: 'c04',
      documentId: 'd04',
      projectId: 'alpha',
      content: '架空製品のNebulaNote v2は日本語検索APIを提供する。',
    },
    {
      id: 'c05',
      documentId: 'd05',
      projectId: 'alpha',
      content: 'Issue #31415 は検索タイムアウトの修正。',
    },
    {
      id: 'c06',
      documentId: 'd06',
      projectId: 'alpha',
      content: 'PR #27182 はkeyword評価の追加。',
    },
    {
      id: 'c07',
      documentId: 'd07',
      projectId: 'alpha',
      content:
        'リポジトリ example-lab/nebula-note の設計。https://example.invalid/nebula/search を参照する。',
    },
    {
      id: 'c08',
      documentId: 'd08',
      projectId: 'alpha',
      content: 'ActivityPub の署名検証と配送retryを実装する。',
    },
    {
      id: 'c09',
      documentId: 'd09',
      projectId: 'alpha',
      content: 'PostgreSQL 18 の接続とpgvector HNSWの設定。',
    },
    {
      id: 'c10',
      documentId: 'd10',
      projectId: 'alpha',
      content: '検索品質評価の結果を記録する。部分一致検索を確認する。',
    },
    {
      id: 'c11',
      documentId: 'd11',
      projectId: 'alpha',
      content: 'NebulaNote の導入手順と運用メモ。',
    },
    {
      id: 'c12',
      documentId: 'd01',
      projectId: 'alpha',
      content: '星舟計画の仕様変更の補足。日本語検索を改善する。',
    },
    {
      id: 'c13',
      documentId: 'd13',
      projectId: 'beta',
      content:
        '星舟計画の仕様変更。NebulaNote ActivityPub Issue #31415 PR #27182。隔離専用語セーフティ。',
    },
    ...Array.from({ length: 24 }, (_, index) => ({
      id: `noise-${String(index).padStart(2, '0')}`,
      documentId: `noise-${String(index).padStart(2, '0')}`,
      projectId: 'alpha',
      content: `架空の日報 ${index}。備品の棚卸しと会議室の予約。`,
    })),
  ],
  cases: [
    {
      id: 'japanese',
      category: 'japanese',
      query: '仕様変更',
      projectId: 'alpha',
      grades: { d01: 3, d02: 2 },
    },
    {
      id: 'mixed',
      category: 'mixed',
      query: '日本語検索API',
      projectId: 'alpha',
      grades: { d04: 3 },
    },
    {
      id: 'person',
      category: 'person',
      query: '空野テスト',
      projectId: 'alpha',
      grades: { d03: 3 },
    },
    {
      id: 'project',
      category: 'project',
      query: '星舟計画',
      projectId: 'alpha',
      grades: { d01: 3, d02: 2, d03: 1 },
    },
    {
      id: 'product',
      category: 'product',
      query: 'NebulaNote',
      projectId: 'alpha',
      grades: { d04: 3, d11: 2 },
    },
    {
      id: 'issue',
      category: 'identifier',
      query: '#31415',
      projectId: 'alpha',
      grades: { d05: 3 },
      required: ['d05'],
    },
    {
      id: 'pr',
      category: 'identifier',
      query: '#27182',
      projectId: 'alpha',
      grades: { d06: 3 },
      required: ['d06'],
    },
    {
      id: 'url',
      category: 'url',
      query: 'https://example.invalid/nebula/search',
      projectId: 'alpha',
      grades: { d07: 3 },
      required: ['d07'],
    },
    {
      id: 'repository',
      category: 'repository',
      query: 'example-lab/nebula-note',
      projectId: 'alpha',
      grades: { d07: 3 },
      required: ['d07'],
    },
    {
      id: 'technical',
      category: 'technical',
      query: 'ActivityPub',
      projectId: 'alpha',
      grades: { d08: 3 },
    },
    {
      id: 'technical-vector',
      category: 'technical',
      query: 'pgvector',
      projectId: 'alpha',
      grades: { d09: 3 },
    },
    {
      id: 'partial',
      category: 'partial',
      query: '検索品質',
      projectId: 'alpha',
      grades: { d10: 3 },
    },
    { id: 'typo', category: 'typo', query: 'ActivtyPub', projectId: 'alpha', grades: { d08: 3 } },
    {
      id: 'width',
      category: 'unicode',
      query: 'ＮｅｂｕｌａＮｏｔｅ',
      projectId: 'alpha',
      grades: { d04: 3, d11: 2 },
    },
    { id: 'empty', category: 'empty', query: '   ', projectId: 'alpha', grades: {} },
    { id: 'symbols', category: 'symbols', query: '!!!', projectId: 'alpha', grades: {} },
    {
      id: 'sql-injection',
      category: 'escaping',
      query: "' OR 1=1; --",
      projectId: 'alpha',
      grades: {},
    },
    {
      id: 'query-injection',
      category: 'escaping',
      query: 'absent OR ActivityPub',
      projectId: 'alpha',
      grades: {},
    },
    {
      id: 'isolation',
      category: 'isolation',
      query: '隔離専用語セーフティ',
      projectId: 'alpha',
      grades: {},
    },
    {
      id: 'beta-positive',
      category: 'isolation',
      query: '隔離専用語セーフティ',
      projectId: 'beta',
      grades: { d13: 3 },
      required: ['d13'],
    },
    {
      id: 'max-length',
      category: 'length',
      query: 'z'.repeat(1000),
      projectId: 'alpha',
      grades: {},
    },
    {
      id: 'over-length',
      category: 'length',
      query: 'z'.repeat(1001),
      projectId: 'alpha',
      grades: {},
      reject: true,
    },
  ] satisfies readonly KeywordEvalCase[],
};
