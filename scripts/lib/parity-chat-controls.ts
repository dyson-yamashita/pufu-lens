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
