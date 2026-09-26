import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectSyntheticChat as collectChat,
  localChatRepository,
  parityChatInputs,
} from './parity-chat.ts';
import { collectLocalChatFailures, normalizeLocalChatError } from './parity-chat-failures.ts';
import { parityRetrievalDocuments } from './parity-retrieval.ts';

const testDatabase = {
  async documentFetch(input: { projectId: string; documentIds: readonly string[] }) {
    return parityRetrievalDocuments()
      .filter((d) => d.projectId === input.projectId && input.documentIds.includes(d.documentId))
      .flatMap((d) => (d.chunks[0] ? [d.chunks[0].candidate] : []));
  },
  async graphCoverageQuery() {
    return {
      candidates: [],
      queryFailed: false,
      relationCandidateCounts: { SAME_AS: 0, RELATED_TO: 0, MENTIONS: 0 },
    };
  },
};
const collectSyntheticChat = (repositories: Parameters<typeof collectChat>[0]) =>
  collectChat(repositories, testDatabase);

test('Chat mapping excludes oracle fields and unsupported capabilities fail closed', () => {
  assert.equal(parityChatInputs().length, 7);
  assert.deepEqual(Object.keys(parityChatInputs()[0] ?? {}).sort(), [
    'id',
    'projectId',
    'question',
  ]);
  assert.throws(() => localChatRepository({}).graphQuery, /Unmeasured/);
  assert.equal(normalizeLocalChatError(new Error('timeout')), 'unavailable');
});

test('real selection and HTTP reflect candidate changes, not relevance expectations', async () => {
  async function collect(documentId: string | null) {
    const candidate = parityRetrievalDocuments().find(
      (document) => document.documentId === documentId,
    )?.chunks[0]?.candidate;
    return collectSyntheticChat({
      keywordCandidateRepository: {
        async search() {
          return [];
        },
      },
      semanticCandidateRepository: {
        async search() {
          return candidate ? [{ ...candidate, rank: 1, cosineDistance: 0.1 }] : [];
        },
      },
    });
  }
  const first = await collect('d01');
  const changed = await collect('d05');
  const empty = await collect(null);
  assert.ok(first.rows.every((row) => row.finalDocumentIds.join() === 'd01'));
  assert.ok(changed.rows.every((row) => row.finalDocumentIds.join() === 'd05'));
  assert.ok(
    empty.rows.every(
      (row) => row.finalDocumentIds.length === 0 && !row.tools.includes('document-fetch'),
    ),
  );
  assert.ok(
    first.rows.every(
      (row) =>
        row.scopePass === null &&
        row.rubricPass === null &&
        row.citationDocumentIds.length === 0 &&
        row.tools.includes('graph-query'),
    ),
  );
  assert.ok(
    first.observations.every((row) => row.sourceRedactionPass && row.workflowHttpRequests === 2),
  );
  assert.equal(first.qualityGate, false);
});

test('membership and HTTP faults propagate through real use-case/client boundaries', async () => {
  const result = await collectLocalChatFailures();
  assert.deepEqual(
    result.observations.map((row) => row.actualError),
    ['project_access_denied', 'timeout', 'overloaded'],
  );
  assert.equal(result.observations[0]?.membershipLookups, 1);
  assert.equal(result.observations[0]?.downstreamCalls, 0);
  assert.ok(result.observations.slice(1).every((row) => row.requests === 2));
  assert.ok(
    result.observations.every((row) => row.scopePass === null && row.mutationPass === null),
  );
});

test('candidate provenance violations and adapter outages abort rather than producing evidence', async () => {
  const candidate = parityRetrievalDocuments()[0]?.chunks[0]?.candidate;
  assert.ok(candidate);
  await assert.rejects(
    collectSyntheticChat({
      keywordCandidateRepository: {
        async search() {
          return [];
        },
      },
      semanticCandidateRepository: {
        async search() {
          return [{ ...candidate, documentId: 'foreign', rank: 1, cosineDistance: 0.1 }];
        },
      },
    }),
    /Invalid Chat candidate provenance/,
  );
  await assert.rejects(
    collectSyntheticChat({
      keywordCandidateRepository: {
        async search() {
          return [];
        },
      },
      semanticCandidateRepository: {
        async search() {
          throw new Error('adapter offline');
        },
      },
    }),
    /adapter offline/,
  );
});
