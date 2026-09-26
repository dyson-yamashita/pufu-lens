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
