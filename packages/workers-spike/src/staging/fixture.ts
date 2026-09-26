/** Fixed synthetic corpus, independent of production content and external embedding APIs. */
export const fixture = {
  version: 'cloudflare-composition-v1',
  schema: '0004_composition',
  model: 'synthetic-v1',
  projects: ['fixture-alpha', 'fixture-beta'],
  documents: ['doc-0', 'doc-1', 'doc-2', 'doc-3'],
} as const;

/** Returns a deterministic nonzero 1536-dimensional vector; not a language embedding. */
export function fixtureVector(document: number, chunk = 0): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === document ? 1 : i === 8 + chunk ? 0.1 : 0));
}

/** Generates the same scoped IDs for every run. Revision 2 updates text; revision 3 is a tombstone. */
export function fixtureSnapshot(projectId: string, document: number, revision: number) {
  if (
    !fixture.projects.some((p) => p === projectId) ||
    !Number.isInteger(document) ||
    document < 0 ||
    document > 3 ||
    ![1, 2, 3].includes(revision)
  )
    throw new Error('Invalid fixture identity');
  const documentId = fixture.documents[document];
  if (!documentId) throw new Error('Invalid fixture document');
  return {
    projectId,
    documentId,
    revision,
    model: fixture.model,
    chunks:
      revision === 3
        ? []
        : [0, 1].map((chunkIndex) => ({
            values: fixtureVector(document, chunkIndex),
            candidate: {
              documentId,
              chunkId: `${documentId}-chunk-${chunkIndex}`,
              chunkIndex,
              rawDocumentId: `${documentId}-raw-${revision}`,
              docType: 'web_page',
              title: `Synthetic ${documentId}`,
              canonicalUri: `https://synthetic.invalid/${documentId}`,
              snippet: `fixturetoken${document} ${projectId} revision ${revision} chunk ${chunkIndex}`,
            },
          })),
  };
}
