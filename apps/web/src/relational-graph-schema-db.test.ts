import assert from 'node:assert/strict';
import { GRAPH_EDGE_TYPES } from '@pufu-lens/graph';
import postgres from 'postgres';
import { jsonParameter } from './postgres-json.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for relational graph schema database tests.');
}

const sql = postgres(databaseUrl, { max: 1 });

const projectId = '10000000-0000-0000-0000-000000000712';
const otherProjectId = '10000000-0000-0000-0000-000000007121';
const mergeProjectId = '10000000-0000-0000-0000-000000007122';
const rollbackProjectId = '10000000-0000-0000-0000-000000007123';

const documentNodeKey = 'document:issue-712-doc';
const actorPrimaryNodeKey = 'actor:issue-712-primary';
const topicNodeKey = 'topic:issue-712-topic';
const unrelatedDocumentNodeKey = 'document:issue-712-unrelated';
const otherProjectDocumentNodeKey = 'document:issue-712-other-project';

const mergePrimaryNodeKey = 'actor:issue-712-merge-primary';
const mergeSecondaryNodeKey = 'actor:issue-712-merge-secondary';
const mergeSharedDocumentNodeKey = 'document:issue-712-merge-shared';
const mergeSecondaryOnlyDocumentNodeKey = 'document:issue-712-merge-secondary-only';
const mergeIncomingDocumentNodeKey = 'document:issue-712-merge-incoming';

const rollbackPrimaryNodeKey = 'actor:issue-712-rollback-primary';
const rollbackSecondaryNodeKey = 'actor:issue-712-rollback-secondary';
const rollbackDocumentNodeKey = 'document:issue-712-rollback-doc';

const mergePrimaryActorId = 'merge-primary-fixture';
const mergeSecondaryActorId = 'merge-secondary-fixture';

await main();

async function main() {
  try {
    await resetFixtureRows();
    await seedProjects();
    await assertValidNodeAndEdgeInserts();
    await assertRejectsUnknownRelationType();
    await assertRejectsNonexistentProjectNode();
    await assertRejectsOrphanAndCrossProjectEndpoints();
    await assertDocumentNodeDeleteCascadesIncidentEdges();
    await assertProjectDeleteCascadesScopedGraph();
    await resetFixtureRows();
    await seedProjects();
    await seedMergeFixture();
    await assertActorMergeTransactionRewiresAndDeletesSecondary();
    await resetFixtureRows();
    await seedProjects();
    await seedRollbackFixture();
    await assertActorMergeRollbackPreservesSecondaryGraph();
    console.log('relational graph schema database tests passed');
  } finally {
    try {
      await resetFixtureRows();
    } finally {
      await sql.end();
    }
  }
}

async function assertValidNodeAndEdgeInserts(): Promise<void> {
  await insertNode(projectId, documentNodeKey, 'document', 'web_page');
  await insertNode(projectId, actorPrimaryNodeKey, 'actor', 'person');
  await insertNode(projectId, topicNodeKey, 'topic', 'keyword');

  for (const relationType of GRAPH_EDGE_TYPES) {
    const targetNodeKey =
      relationType === 'MENTIONS' || relationType === 'RELATED_TO' || relationType === 'SAME_AS'
        ? topicNodeKey
        : documentNodeKey;
    await insertEdge({
      projectId,
      properties: { fixture: relationType },
      relationType,
      sourceNodeKey: actorPrimaryNodeKey,
      targetNodeKey,
    });
  }

  assert.equal(await countEdges(projectId), GRAPH_EDGE_TYPES.length);
}

async function assertRejectsUnknownRelationType(): Promise<void> {
  await assert.rejects(
    () =>
      insertEdge({
        projectId,
        properties: {},
        relationType: 'UNKNOWN_RELATION',
        sourceNodeKey: actorPrimaryNodeKey,
        targetNodeKey: documentNodeKey,
      }),
    /relation_type|check constraint|graph_edges_relation_type_check/i,
  );
}

async function assertRejectsNonexistentProjectNode(): Promise<void> {
  await assert.rejects(
    () =>
      insertNode('10000000-0000-0000-0000-000000000799', documentNodeKey, 'document', 'web_page'),
    /foreign key|graph_nodes_project_id_fkey/i,
  );
}

async function assertRejectsOrphanAndCrossProjectEndpoints(): Promise<void> {
  await insertNode(otherProjectId, otherProjectDocumentNodeKey, 'document', 'web_page');
  await insertEdge({
    projectId: otherProjectId,
    properties: { fixture: 'other-project-self' },
    relationType: 'RELATED_TO',
    sourceNodeKey: otherProjectDocumentNodeKey,
    targetNodeKey: otherProjectDocumentNodeKey,
  });

  await assert.rejects(
    () =>
      insertEdge({
        projectId,
        properties: {},
        relationType: 'SENT',
        sourceNodeKey: 'document:issue-712-missing-source',
        targetNodeKey: documentNodeKey,
      }),
    /foreign key|graph_edges_source_node_fkey/i,
  );

  await assert.rejects(
    () =>
      insertEdge({
        projectId,
        properties: {},
        relationType: 'SENT',
        sourceNodeKey: actorPrimaryNodeKey,
        targetNodeKey: 'document:issue-712-missing-target',
      }),
    /foreign key|graph_edges_target_node_fkey/i,
  );

  await assert.rejects(
    () =>
      insertEdge({
        projectId,
        properties: {},
        relationType: 'SENT',
        sourceNodeKey: actorPrimaryNodeKey,
        targetNodeKey: otherProjectDocumentNodeKey,
      }),
    /foreign key|graph_edges_target_node_fkey/i,
  );
}

async function assertDocumentNodeDeleteCascadesIncidentEdges(): Promise<void> {
  await insertNode(projectId, unrelatedDocumentNodeKey, 'document', 'web_page');
  await insertEdge({
    projectId,
    properties: { direction: 'outgoing' },
    relationType: 'SENT',
    sourceNodeKey: documentNodeKey,
    targetNodeKey: unrelatedDocumentNodeKey,
  });
  await insertEdge({
    projectId,
    properties: { direction: 'incoming' },
    relationType: 'MENTIONS',
    sourceNodeKey: unrelatedDocumentNodeKey,
    targetNodeKey: documentNodeKey,
  });

  const edgeCountBefore = await countEdges(projectId);
  assert.ok(edgeCountBefore > 0);
  const documentIncidentEdgeCount =
    GRAPH_EDGE_TYPES.filter(
      (relationType) =>
        relationType !== 'MENTIONS' && relationType !== 'RELATED_TO' && relationType !== 'SAME_AS',
    ).length + 2;

  await sql`
    DELETE FROM public.graph_nodes
    WHERE project_id = ${projectId}
      AND node_key = ${documentNodeKey}
  `;

  assert.equal(await countNode(projectId, documentNodeKey), 0);
  assert.equal(await countNode(projectId, unrelatedDocumentNodeKey), 1);
  assert.equal(await countEdgesForNode(projectId, documentNodeKey), 0);
  assert.equal(await countEdges(projectId), edgeCountBefore - documentIncidentEdgeCount);
}

async function assertProjectDeleteCascadesScopedGraph(): Promise<void> {
  const otherProjectEdgeCountBefore = await countEdges(otherProjectId);
  assert.ok(otherProjectEdgeCountBefore > 0);

  await sql`DELETE FROM public.projects WHERE id = ${projectId}`;

  assert.equal(await countNodes(projectId), 0);
  assert.equal(await countEdges(projectId), 0);
  assert.ok((await countNodes(otherProjectId)) > 0);
  assert.equal(await countEdges(otherProjectId), otherProjectEdgeCountBefore);
}

async function assertActorMergeTransactionRewiresAndDeletesSecondary(): Promise<void> {
  await sql.begin(async (tx) => {
    await executeRelationalActorMerge(tx, {
      primaryActorId: mergePrimaryActorId,
      primaryNodeKey: mergePrimaryNodeKey,
      projectId: mergeProjectId,
      secondaryNodeKey: mergeSecondaryNodeKey,
    });
  });

  assert.equal(await countNode(mergeProjectId, mergeSecondaryNodeKey), 0);
  assert.equal(await countEdgesForNode(mergeProjectId, mergeSecondaryNodeKey), 0);

  const sharedEdge = await readEdgeProperties({
    projectId: mergeProjectId,
    relationType: 'AUTHORED',
    sourceNodeKey: mergePrimaryNodeKey,
    targetNodeKey: mergeSharedDocumentNodeKey,
  });
  assert.equal(sharedEdge.actorId, mergePrimaryActorId);
  assert.equal(sharedEdge.weight, 42);

  const migratedEdge = await readEdgeProperties({
    projectId: mergeProjectId,
    relationType: 'SENT',
    sourceNodeKey: mergePrimaryNodeKey,
    targetNodeKey: mergeSecondaryOnlyDocumentNodeKey,
  });
  assert.equal(migratedEdge.actorId, mergePrimaryActorId);
  assert.equal(migratedEdge.channel, 'secondary-only');

  const incomingEdge = await readEdgeProperties({
    projectId: mergeProjectId,
    relationType: 'MENTIONS',
    sourceNodeKey: mergeIncomingDocumentNodeKey,
    targetNodeKey: mergePrimaryNodeKey,
  });
  assert.equal(incomingEdge.fixture, 'incoming');
}

async function assertActorMergeRollbackPreservesSecondaryGraph(): Promise<void> {
  const edgeCountBefore = await countEdges(rollbackProjectId);

  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await executeRelationalActorMerge(tx, {
          primaryActorId: 'rollback-primary-fixture',
          primaryNodeKey: rollbackPrimaryNodeKey,
          projectId: rollbackProjectId,
          secondaryNodeKey: rollbackSecondaryNodeKey,
        });
        throw new Error('deliberate actor merge rollback');
      }),
    /deliberate actor merge rollback/,
  );

  assert.equal(await countNode(rollbackProjectId, rollbackSecondaryNodeKey), 1);
  assert.equal(await countEdges(rollbackProjectId), edgeCountBefore);
  assert.equal(
    await countEdgesBetween({
      projectId: rollbackProjectId,
      relationType: 'AUTHORED',
      sourceNodeKey: rollbackSecondaryNodeKey,
      targetNodeKey: rollbackDocumentNodeKey,
    }),
    1,
  );
  assert.equal(
    await countEdgesBetween({
      projectId: rollbackProjectId,
      relationType: 'AUTHORED',
      sourceNodeKey: rollbackPrimaryNodeKey,
      targetNodeKey: rollbackDocumentNodeKey,
    }),
    0,
  );
}

async function executeRelationalActorMerge(
  tx: postgres.TransactionSql,
  input: {
    readonly primaryActorId: string;
    readonly primaryNodeKey: string;
    readonly projectId: string;
    readonly secondaryNodeKey: string;
  },
): Promise<void> {
  const primaryActorProperties = sql.json({ actorId: input.primaryActorId });

  await tx`
    INSERT INTO public.graph_edges (
      project_id, source_node_key, target_node_key, relation_type, properties
    )
    SELECT
      project_id,
      ${input.primaryNodeKey},
      target_node_key,
      relation_type,
      properties || ${primaryActorProperties}
    FROM public.graph_edges
    WHERE project_id = ${input.projectId}
      AND source_node_key = ${input.secondaryNodeKey}
    ON CONFLICT (project_id, source_node_key, target_node_key, relation_type) DO NOTHING
  `;

  await tx`
    INSERT INTO public.graph_edges (
      project_id, source_node_key, target_node_key, relation_type, properties
    )
    SELECT
      project_id,
      source_node_key,
      ${input.primaryNodeKey},
      relation_type,
      properties || ${primaryActorProperties}
    FROM public.graph_edges
    WHERE project_id = ${input.projectId}
      AND target_node_key = ${input.secondaryNodeKey}
    ON CONFLICT (project_id, source_node_key, target_node_key, relation_type) DO NOTHING
  `;

  await tx`
    DELETE FROM public.graph_edges
    WHERE project_id = ${input.projectId}
      AND (
        source_node_key = ${input.secondaryNodeKey}
        OR target_node_key = ${input.secondaryNodeKey}
      )
  `;

  await tx`
    DELETE FROM public.graph_nodes
    WHERE project_id = ${input.projectId}
      AND node_key = ${input.secondaryNodeKey}
  `;
}

async function seedProjects(): Promise<void> {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES
      (
        ${projectId},
        'issue-712-relational-graph',
        'Issue 712 Relational Graph',
        'graph_issue_712_relational',
        'issue-712-relational-graph',
        'private'
      ),
      (
        ${otherProjectId},
        'issue-712-relational-other',
        'Issue 712 Relational Other',
        'graph_issue_712_relational_other',
        'issue-712-relational-other',
        'private'
      ),
      (
        ${mergeProjectId},
        'issue-712-relational-merge',
        'Issue 712 Relational Merge',
        'graph_issue_712_relational_merge',
        'issue-712-relational-merge',
        'private'
      ),
      (
        ${rollbackProjectId},
        'issue-712-relational-rollback',
        'Issue 712 Relational Rollback',
        'graph_issue_712_relational_rollback',
        'issue-712-relational-rollback',
        'private'
      )
  `;
}

async function seedMergeFixture(): Promise<void> {
  await insertNode(mergeProjectId, mergePrimaryNodeKey, 'actor', 'person');
  await insertNode(mergeProjectId, mergeSecondaryNodeKey, 'actor', 'person');
  await insertNode(mergeProjectId, mergeSharedDocumentNodeKey, 'document', 'web_page');
  await insertNode(mergeProjectId, mergeSecondaryOnlyDocumentNodeKey, 'document', 'email');
  await insertNode(mergeProjectId, mergeIncomingDocumentNodeKey, 'document', 'web_page');

  await insertEdge({
    projectId: mergeProjectId,
    properties: { actorId: mergePrimaryActorId, weight: 42 },
    relationType: 'AUTHORED',
    sourceNodeKey: mergePrimaryNodeKey,
    targetNodeKey: mergeSharedDocumentNodeKey,
  });
  await insertEdge({
    projectId: mergeProjectId,
    properties: { actorId: mergeSecondaryActorId, weight: 7 },
    relationType: 'AUTHORED',
    sourceNodeKey: mergeSecondaryNodeKey,
    targetNodeKey: mergeSharedDocumentNodeKey,
  });
  await insertEdge({
    projectId: mergeProjectId,
    properties: { actorId: mergeSecondaryActorId, channel: 'secondary-only' },
    relationType: 'SENT',
    sourceNodeKey: mergeSecondaryNodeKey,
    targetNodeKey: mergeSecondaryOnlyDocumentNodeKey,
  });
  await insertEdge({
    projectId: mergeProjectId,
    properties: { fixture: 'incoming' },
    relationType: 'MENTIONS',
    sourceNodeKey: mergeIncomingDocumentNodeKey,
    targetNodeKey: mergeSecondaryNodeKey,
  });
}

async function seedRollbackFixture(): Promise<void> {
  await insertNode(rollbackProjectId, rollbackPrimaryNodeKey, 'actor', 'person');
  await insertNode(rollbackProjectId, rollbackSecondaryNodeKey, 'actor', 'person');
  await insertNode(rollbackProjectId, rollbackDocumentNodeKey, 'document', 'web_page');
  await insertEdge({
    projectId: rollbackProjectId,
    properties: { actorId: 'rollback-secondary-fixture' },
    relationType: 'AUTHORED',
    sourceNodeKey: rollbackSecondaryNodeKey,
    targetNodeKey: rollbackDocumentNodeKey,
  });
}

async function insertNode(
  targetProjectId: string,
  nodeKey: string,
  kind: string,
  subtype: string | null,
): Promise<void> {
  await sql`
    INSERT INTO public.graph_nodes (project_id, node_key, kind, subtype, properties)
    VALUES (${targetProjectId}, ${nodeKey}, ${kind}, ${subtype}, ${sql.json({})})
  `;
}

async function insertEdge(input: {
  readonly projectId: string;
  readonly properties: Record<string, unknown>;
  readonly relationType: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
}): Promise<void> {
  await sql`
    INSERT INTO public.graph_edges (
      project_id, source_node_key, target_node_key, relation_type, properties
    )
    VALUES (
      ${input.projectId},
      ${input.sourceNodeKey},
      ${input.targetNodeKey},
      ${input.relationType},
      ${jsonParameter(sql, input.properties)}
    )
  `;
}

async function countNodes(targetProjectId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_nodes
    WHERE project_id = ${targetProjectId}
  `) as readonly unknown[];
  return numberField(singleRow(rows), 'count');
}

async function countNode(targetProjectId: string, nodeKey: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_nodes
    WHERE project_id = ${targetProjectId}
      AND node_key = ${nodeKey}
  `) as readonly unknown[];
  return numberField(singleRow(rows), 'count');
}

async function countEdges(targetProjectId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_edges
    WHERE project_id = ${targetProjectId}
  `) as readonly unknown[];
  return numberField(singleRow(rows), 'count');
}

async function countEdgesForNode(targetProjectId: string, nodeKey: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_edges
    WHERE project_id = ${targetProjectId}
      AND (source_node_key = ${nodeKey} OR target_node_key = ${nodeKey})
  `) as readonly unknown[];
  return numberField(singleRow(rows), 'count');
}

async function countEdgesBetween(input: {
  readonly projectId: string;
  readonly relationType: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
}): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_edges
    WHERE project_id = ${input.projectId}
      AND source_node_key = ${input.sourceNodeKey}
      AND target_node_key = ${input.targetNodeKey}
      AND relation_type = ${input.relationType}
  `) as readonly unknown[];
  return numberField(singleRow(rows), 'count');
}

async function readEdgeProperties(input: {
  readonly projectId: string;
  readonly relationType: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
}): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT properties
    FROM public.graph_edges
    WHERE project_id = ${input.projectId}
      AND source_node_key = ${input.sourceNodeKey}
      AND target_node_key = ${input.targetNodeKey}
      AND relation_type = ${input.relationType}
  `) as readonly unknown[];
  const properties = singleRow(rows).properties;
  assert.ok(properties && typeof properties === 'object' && !Array.isArray(properties));
  return properties as Record<string, unknown>;
}

async function resetFixtureRows(): Promise<void> {
  await sql`DELETE FROM public.graph_edges WHERE project_id IN (${projectId}, ${otherProjectId}, ${mergeProjectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.graph_nodes WHERE project_id IN (${projectId}, ${otherProjectId}, ${mergeProjectId}, ${rollbackProjectId})`;
  await sql`DELETE FROM public.projects WHERE id IN (${projectId}, ${otherProjectId}, ${mergeProjectId}, ${rollbackProjectId})`;
}

function singleRow(rows: readonly unknown[]): Record<string, unknown> {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row && typeof row === 'object' && !Array.isArray(row));
  return row as Record<string, unknown>;
}

function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Expected ${key} to be numeric.`);
}
