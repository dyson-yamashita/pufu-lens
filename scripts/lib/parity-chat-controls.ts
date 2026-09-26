/** Independent wiring inputs; controls only remove real primary results, never create candidates.
 * Query text stays in this fixture; report artifacts store its hash. These are not v1 quality cases.
 */
export const chatControlledScenarios = [
  {
    id: 'primary-empty-retry',
    projectId: 'alpha',
    question: '検索の仕様と移行について決まったことは？',
    primaryDocumentAllowlist: [],
  },
  {
    id: 'single-seed-graph-final',
    projectId: 'alpha',
    question: '検索の仕様と移行について決まったことは？',
    primaryDocumentAllowlist: ['d01'],
  },
] as const;

/** Replays an existing input identity with a missing-detail fault after the real DB read.
 * This does not add or reinterpret embedding queries, classification, or selection policy.
 */
export const chatFinalSourceBoundary = {
  version: 'chat-final-source-boundary-v1',
  inputCaseId: 'single-seed-graph-final',
  boundary: 'detail-result-after-real-document-repository',
  omittedDocumentIds: ['d02'],
} as const;

/** Independent synthetic-only plan; classification is an explicit input stub, not an LLM result.
 * Document limits are supported preparation inputs, not changed selection policies.
 * Primary filters remove real results only; retry, coverage and detail reads are untouched.
 */
export const chatClassifiedPlan = {
  version: 'chat-classified-priority-v1',
  embedding: 'sha256-synthetic-only',
  classification: {
    confidence: 'high',
    expectedEvidence: [],
    figure: [],
    ground: [],
    primaryOperation: 'relation',
    secondaryOperations: [],
  },
  scenarios: [
    {
      id: 'classified-full',
      primaryOperation: 'cause',
      primaryDocumentAllowlist: ['d01', 'd09'],
      documentLimit: 2,
    },
    {
      id: 'classified-quota',
      primaryOperation: 'relation',
      primaryDocumentAllowlist: ['d01', 'd09'],
      documentLimit: 2,
    },
    {
      id: 'classified-single',
      primaryOperation: 'relation',
      primaryDocumentAllowlist: ['d01'],
      documentLimit: 1,
    },
    {
      id: 'classified-room',
      primaryOperation: 'relation',
      primaryDocumentAllowlist: ['d01'],
      documentLimit: 5,
    },
    {
      id: 'classified-retry',
      primaryOperation: 'relation',
      primaryDocumentAllowlist: [],
      documentLimit: 1,
    },
  ],
  projectId: 'alpha',
  question: '検索の仕様と移行について決まったことは？',
} as const;
