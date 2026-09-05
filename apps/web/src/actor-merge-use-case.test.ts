import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { GraphMutationRepository } from '@pufu-lens/graph';
import type postgres from 'postgres';
import { executeActorMerge } from './actor-merge-use-case.ts';

const primaryActorId = '10000000-0000-0000-0000-000000000701';
const secondaryActorId = '10000000-0000-0000-0000-000000000702';
const projectId = '10000000-0000-0000-0000-000000000703';
const adminUserId = '10000000-0000-0000-0000-000000000704';

const actorRows = [
  {
    id: primaryActorId,
    displayName: 'Primary Actor',
    graphNodeId: 'actor:primary',
    status: 'active',
  },
  {
    id: secondaryActorId,
    displayName: 'Secondary Actor',
    graphNodeId: 'actor:secondary',
    status: 'active',
  },
];

await assertUnavailableMergeRejectsTransaction();
await assertMutationCompositionSourcesAvoidProviderSyntax();

console.log('web actor merge use-case tests passed');

async function assertUnavailableMergeRejectsTransaction(): Promise<void> {
  const tx = createActorMergeTransactionMock(actorRows);
  const mutationRepository = createUnavailableMutationRepository();

  await assert.rejects(
    () =>
      executeActorMerge(tx, mutationRepository, {
        adminUserId,
        primaryActorId,
        projectId,
        reason: 'unavailable rollback test',
        secondaryActorId,
      }),
    /Actor graph merge unavailable/,
  );
}

async function assertMutationCompositionSourcesAvoidProviderSyntax(): Promise<void> {
  const mutationSources = [
    new URL('./actor-merge-use-case.ts', import.meta.url),
    new URL('./admin-actor-actions.ts', import.meta.url),
    new URL('./admin-data-source-actions.ts', import.meta.url),
    new URL('./admin-project-actions.ts', import.meta.url),
    new URL('./delete-project-use-case.ts', import.meta.url),
  ];

  for (const sourceUrl of mutationSources) {
    const source = await readFile(sourceUrl, 'utf8');
    assert.doesNotMatch(source, /cypher\(/);
    assert.doesNotMatch(source, /agtype/);
    assert.doesNotMatch(source, /create_graph/);
    assert.doesNotMatch(source, /drop_graph/);
    assert.doesNotMatch(source, /LOAD 'age'/);
  }

  const dataSourceSource = await readFile(
    new URL('./admin-data-source-actions.ts', import.meta.url),
    'utf8',
  );
  const deleteDataSourceMatch = dataSourceSource.match(
    /export async function deleteDataSource[\s\S]*?^}/m,
  );
  assert.ok(deleteDataSourceMatch, 'deleteDataSource should exist');
  const deleteDataSourceSource = deleteDataSourceMatch[0] ?? '';
  assert.match(deleteDataSourceSource, /deleteDocumentGraphNodes\(/);
  assert.ok(
    deleteDataSourceSource.indexOf('deleteDocumentGraphNodes') <
      deleteDataSourceSource.indexOf('DELETE FROM public.raw_documents'),
    'graph cleanup must run before source rows are deleted in the same transaction',
  );
  assert.match(deleteDataSourceSource, /projectId:\s*project\.id/);
  assert.doesNotMatch(deleteDataSourceSource, /graphName/);
}

function createUnavailableMutationRepository(): GraphMutationRepository {
  return {
    async deleteDocumentGraphNodes() {
      return 0;
    },
    async deleteProjectGraph() {},
    async ensureProjectGraph() {},
    async mergeActorGraphNodes() {
      return { status: 'unavailable' };
    },
    async upsertEdge() {},
    async upsertNode() {},
  };
}

function createActorMergeTransactionMock(
  actors: readonly {
    readonly displayName: string;
    readonly graphNodeId: string;
    readonly id: string;
    readonly status: string;
  }[],
): postgres.TransactionSql {
  const transaction = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = String.raw({ raw: strings }, ...values);
      if (query.includes('FROM public.actors') && query.includes('FOR UPDATE')) {
        return actors;
      }
      if (query.includes('UPDATE public.actors') && query.includes('RETURNING')) {
        const secondaryActor = actors.find((actor) => actor.id === secondaryActorId);
        return secondaryActor
          ? [
              {
                ...secondaryActor,
                status: 'merged',
              },
            ]
          : [];
      }
      return [];
    },
    {
      json: (value: unknown) => value,
    },
  );
  return transaction as unknown as postgres.TransactionSql;
}
