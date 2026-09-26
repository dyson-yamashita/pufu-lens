import { createHash } from 'node:crypto';
import { GRAPH_EDGE_TYPES } from '@pufu-lens/graph';
import { keywordCorpus } from './keyword-eval-corpus.ts';

export type ParityKind = 'keyword' | 'semantic' | 'hybrid' | 'graph' | 'chat' | 'mutation';
export interface ParityCase {
  id: string;
  kind: ParityKind;
  category: string;
  query: string;
  projectId: string;
  forbiddenProjectIds: readonly string[];
  grades: Readonly<Record<string, number>>;
  required: readonly string[];
  requiredTools: readonly string[];
  expectedFailure: string | null;
  // Canonical tuples: [project, source, relation, target, hop]; node tuples use NODE and hop 0.
  graph: readonly (readonly [string, string, string, string, number])[];
  graphInput?: readonly (readonly [string, string, string, string, number])[];
  operation?: string;
}

const base = {
  projectId: 'alpha',
  forbiddenProjectIds: ['beta'],
  grades: {},
  required: [],
  requiredTools: [],
  expectedFailure: null,
  graph: [],
};
const semantic: Pick<ParityCase, 'id' | 'query' | 'grades' | 'required'>[] = [
  {
    id: 'design',
    query: '検索の仕様と移行について決まったことは？',
    grades: { d01: 3, d02: 2 },
    required: ['d01'],
  },
  { id: 'owner', query: '星舟計画の品質を担当するのは誰？', grades: { d03: 3 }, required: ['d03'] },
  {
    id: 'timeout',
    query: '検索が時間切れになる問題の修正Issueは？',
    grades: { d05: 3 },
    required: ['d05'],
  },
];
export const parityCases: readonly ParityCase[] = [
  ...keywordCorpus.cases.map(
    (row): ParityCase => ({
      ...base,
      ...row,
      id: `keyword-${row.id}`,
      kind: 'keyword',
      forbiddenProjectIds: [row.projectId === 'alpha' ? 'beta' : 'alpha'],
      required: row.required ?? [],
      expectedFailure: row.reject ? 'rejected' : null,
    }),
  ),
  ...(['semantic', 'hybrid', 'chat'] as const).flatMap((kind) =>
    semantic.map(
      (row): ParityCase => ({
        ...base,
        ...row,
        id: `${kind}-${row.id}`,
        kind,
        category: row.id,
        requiredTools: kind === 'chat' ? ['hybrid-search', 'graph-query', 'document-fetch'] : [],
      }),
    ),
  ),
  ...(['SAME_AS', 'RELATED_TO', 'MENTIONS'] as const).map(
    (relation): ParityCase => ({
      ...base,
      id: `graph-${relation}`,
      kind: 'graph',
      category: 'hop-dedupe-limit',
      query: `d01 ${relation} hop=1 limit=1`,
      graphInput: [
        ['alpha', 'd01', relation, 'd02', 1],
        ['alpha', 'd02', relation, 'd03', 1],
      ],
      operation: 'read from d01 with maxHops=1, per-relation limit=1; dedupe before returning',
      graph: [['alpha', 'd01', relation, 'd02', 1]],
    }),
  ),
  ...['duplicate', 'cleanup', 'orphan', 'retry'].map(
    (operation): ParityCase => ({
      ...base,
      id: `mutation-${operation}`,
      kind: 'mutation',
      category: operation,
      query: operation,
      graphInput: [
        ['alpha', 'd01', 'NODE', 'd01', 0],
        ['alpha', 'd02', 'NODE', 'd02', 0],
        ['alpha', 'd01', 'RELATED_TO', 'd02', 1],
      ],
      operation:
        operation === 'cleanup'
          ? 'delete d02 and its incident edges'
          : operation === 'orphan'
            ? 'delete all documents and orphan nodes'
            : 'upsert the same nodes and edge twice; retry must be idempotent',
      graph:
        operation === 'orphan'
          ? []
          : operation === 'cleanup'
            ? [['alpha', 'd01', 'NODE', 'd01', 0]]
            : [
                ['alpha', 'd01', 'NODE', 'd01', 0],
                ['alpha', 'd02', 'NODE', 'd02', 0],
                ['alpha', 'd01', 'RELATED_TO', 'd02', 1],
              ],
    }),
  ),
  {
    ...base,
    id: 'mutation-merge',
    kind: 'mutation',
    category: 'merge',
    query: 'merge Actor aliases',
    operation: 'merge actor:b into actor:a; rewire AUTHORED and remove the SAME_AS self-edge',
    graphInput: [
      ['alpha', 'actor:a', 'NODE', 'actor:a', 0],
      ['alpha', 'actor:b', 'NODE', 'actor:b', 0],
      ['alpha', 'd01', 'NODE', 'd01', 0],
      ['alpha', 'actor:a', 'SAME_AS', 'actor:b', 1],
      ['alpha', 'actor:b', 'AUTHORED', 'd01', 1],
    ],
    graph: [
      ['alpha', 'actor:a', 'NODE', 'actor:a', 0],
      ['alpha', 'd01', 'NODE', 'd01', 0],
      ['alpha', 'actor:a', 'AUTHORED', 'd01', 1],
    ],
  },
  ...GRAPH_EDGE_TYPES.map(
    (relation): ParityCase => ({
      ...base,
      id: `mutation-edge-${relation}`,
      kind: 'mutation',
      category: 'edge-types',
      query: relation,
      graphInput: [],
      operation: `upsert nodes d01/d02 and one ${relation} edge; snapshot nodes and edges`,
      graph: [
        ['alpha', 'd01', 'NODE', 'd01', 0],
        ['alpha', 'd02', 'NODE', 'd02', 0],
        ['alpha', 'd01', relation, 'd02', 1],
      ],
    }),
  ),
  ...['project_access_denied', 'timeout', 'overloaded', 'stale_read'].map(
    (failure): ParityCase => ({
      ...base,
      id: `failure-${failure}`,
      kind: 'chat',
      category: 'failure',
      query: 'sample-a の資料を見せて',
      expectedFailure: failure,
    }),
  ),
];

/** Shared synthetic corpus and immutable chunk/document mapping; never copied from production. */
export const parityFixture = {
  version: 'backend-parity-synthetic-v1',
  schemaVersion: 1,
  chunks: keywordCorpus.chunks,
  graphNodes: [
    ...[
      ...new Map(
        keywordCorpus.chunks.map((chunk) => [
          chunk.documentId,
          {
            id: chunk.documentId,
            projectId: chunk.projectId,
            kind: 'document',
          },
        ]),
      ).values(),
    ],
    { id: 'actor:a', projectId: 'alpha', kind: 'actor' },
    { id: 'actor:b', projectId: 'alpha', kind: 'actor' },
  ],
  cases: parityCases,
  chunkJudgments: parityCases.map((test) => ({
    id: test.id,
    grades: Object.fromEntries(
      keywordCorpus.chunks
        .filter(
          (chunk) => chunk.projectId === test.projectId && (test.grades[chunk.documentId] ?? 0) > 0,
        )
        .map((chunk) => [chunk.id, test.grades[chunk.documentId]]),
    ),
  })),
  embedding: { mode: 'real', model: 'text-embedding-3-small', dimensions: 1536, metric: 'cosine' },
} as const;

export const parityFixtureHash = createHash('sha256')
  .update(JSON.stringify(parityFixture))
  .digest('hex');
export const parityMappingHash = createHash('sha256')
  .update(
    JSON.stringify(
      parityFixture.chunks.map(({ id, documentId, projectId }) => [id, documentId, projectId]),
    ),
  )
  .digest('hex');
