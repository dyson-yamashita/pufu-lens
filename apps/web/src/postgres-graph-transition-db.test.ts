import assert from 'node:assert/strict';
import { createPostgresAgeGraphMutationRepository } from '@pufu-lens/graph/postgres-age-mutation';
import { createPostgresRelationalGraphMutationRepository } from '@pufu-lens/graph/postgres-relational-mutation';
import { createPostgresRelationalGraphReadRepository } from '@pufu-lens/graph/postgres-relational-read';
import { createPostgresGraphTransitionMutationRepository } from '@pufu-lens/graph/postgres-transition-mutation';
import {
  createGraphShadowMutationRepository,
  GraphShadowMutationError,
} from '@pufu-lens/graph/shadow';
import postgres from 'postgres';
import { createPostgresAgeGraphReadRepository } from './postgres-graph-read-adapter.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for graph transition database tests.');
}

const sql = postgres(databaseUrl, { max: 1 });
const projectId = '10000000-0000-0000-0000-000000000718';
const graphName = 'graph_issue_718_transition';
const committedNode = 'document:issue-718-committed';
const rollbackNode = 'document:issue-718-rollback';

await main();

async function main(): Promise<void> {
  try {
    await resetFixture();
    await sql`
      INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
      VALUES (
        ${projectId},
        'issue-718-graph-transition',
        'Issue 718 Graph Transition',
        ${graphName},
        'issue-718-graph-transition',
        'private'
      )
    `;
    await createPostgresAgeGraphMutationRepository(sql).ensureProjectGraph({ projectId });

    await sql.begin(async (tx) => {
      await createPostgresGraphTransitionMutationRepository(tx, {
        observer: () => undefined,
        transitionMode: 'dual-write',
      }).upsertNode(nodeInput(committedNode));
    });
    await assertCounts(committedNode, 1);

    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          const relational = createPostgresRelationalGraphMutationRepository(tx);
          const repository = createGraphShadowMutationRepository({
            mode: 'dual-write',
            primary: createPostgresAgeGraphMutationRepository(tx),
            shadow: {
              ...relational,
              async upsertNode(input) {
                await relational.upsertNode(input);
                throw new Error('deliberate shadow failure');
              },
            },
          });
          await repository.upsertNode(nodeInput(rollbackNode));
        }),
      GraphShadowMutationError,
    );
    await assertCounts(rollbackNode, 0);

    await sql.begin(async (tx) => {
      await createPostgresGraphTransitionMutationRepository(tx, {
        observer: () => undefined,
        transitionMode: 'dual-write',
      }).upsertNode(nodeInput(rollbackNode));
    });
    await assertCounts(rollbackNode, 1);

    console.log('graph transition database tests passed');
  } finally {
    await resetFixture();
    await sql.end();
  }
}

function nodeInput(graphNodeId: string) {
  return {
    graphNodeId,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      graphLabels: ['Document'],
      graphNodeId,
    },
  };
}

async function assertCounts(graphNodeId: string, expected: number): Promise<void> {
  const input = { graphNodeId, projectId };
  assert.equal(await createPostgresAgeGraphReadRepository(sql).countDocumentNode(input), expected);
  assert.equal(
    await createPostgresRelationalGraphReadRepository(sql).countDocumentNode(input),
    expected,
  );
}

async function resetFixture(): Promise<void> {
  const rows = (await sql`
    SELECT 1
    FROM public.projects
    WHERE id = ${projectId}::uuid
  `) as readonly unknown[];
  if (rows.length > 0) {
    await createPostgresAgeGraphMutationRepository(sql).deleteProjectGraph({ projectId });
  }
  await sql`DELETE FROM public.projects WHERE id = ${projectId}::uuid`;
}
