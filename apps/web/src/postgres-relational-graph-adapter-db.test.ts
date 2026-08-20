import assert from 'node:assert/strict';
import { GRAPH_EDGE_TYPES, GRAPH_PRESET_IDS } from '@pufu-lens/graph';
import { createPostgresRelationalGraphMutationRepository } from '@pufu-lens/graph/postgres-relational-mutation';
import { createPostgresRelationalGraphReadRepository } from '@pufu-lens/graph/postgres-relational-read';
import { MemoryObjectStorage } from '@pufu-lens/storage/testing';
import postgres from 'postgres';
import { type GraphViewerRepository, runGraphPresetQuery } from './graph-viewer.ts';
import {
  nullableStringField,
  numberField,
  requireJsonObjectField,
  singleRow,
  stringField,
  timestampField,
} from './postgres-relational-graph-adapter-db-support.ts';
import { createPostgresSyntheticMonitorRepository } from './synthetic-monitor-repository.ts';
import { runSyntheticMonitorObservations } from './synthetic-monitor-service.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for relational graph adapter database tests.');
}

const sql = postgres(databaseUrl, { max: 1 });
const mutationRepository = createPostgresRelationalGraphMutationRepository(sql);
const graphReadRepository = createPostgresRelationalGraphReadRepository(sql);

const projectId = '10000000-0000-0000-0000-000000000714';
const otherProjectId = '10000000-0000-0000-0000-000000007141';
const mergeProjectId = '10000000-0000-0000-0000-000000007142';
const rollbackProjectId = '10000000-0000-0000-0000-000000007143';
const monitorProjectId = '10000000-0000-0000-0000-000000007144';
const missingProjectId = '10000000-0000-0000-0000-000000007149';
const monitorUserId = '71400000-0000-0000-0000-000000000010';
const monitorDataSourceId = '71400000-0000-0000-0000-000000000011';
const monitorRawDocumentId = '71400000-0000-0000-0000-000000000012';
const monitorDocumentId = '71400000-0000-0000-0000-000000000013';

const seedDocumentId = '71400000-0000-0000-0000-000000000001';
const sameAsDocumentIdA = '71400000-0000-0000-0000-000000000002';
const sameAsDocumentIdB = '71400000-0000-0000-0000-000000000003';
const relatedDocumentIdA = '71400000-0000-0000-0000-000000000004';
const relatedDocumentIdB = '71400000-0000-0000-0000-000000000005';
const mentionsDocumentId = '71400000-0000-0000-0000-000000000006';

const seedNodeKey = 'document:issue-714-seed';
const sameAsNodeKeyA = 'document:issue-714-same-a';
const sameAsNodeKeyB = 'document:issue-714-same-b';
const sameAsUtfBmpPeerKey = `actor:issue-714-utf-bmp-${'\uE000'}`;
const sameAsUtfNonBmpPeerKey = `actor:issue-714-utf-nonbmp-${'\u{10000}'}`;
const relatedNodeKeyA = 'document:issue-714-related-a';
const relatedNodeKeyB = 'document:issue-714-related-b';
const mentionsNodeKey = 'document:issue-714-mentions';
const actorNodeKey = 'actor:issue-714-actor';
const topicNodeKey = 'topic:issue-714-topic';
const unrelatedDocumentNodeKey = 'document:issue-714-unrelated';
const countRelationsNodeKey = 'document:issue-714-count-relations';
const otherProjectDocumentNodeKey = 'document:issue-714-other-project';
const monitorGraphNodeId = 'document:issue-714-monitor';

const mergePrimaryNodeKey = 'actor:issue-714-merge-primary';
const mergeSecondaryNodeKey = 'actor:issue-714-merge-secondary';
const mergeCollisionPeerNodeKey = 'actor:issue-714-merge-aa-peer';
const mergeCanonicalizationPeerNodeKey = 'actor:issue-714-merge-rr-peer';
const mergeUtfPrimaryNodeKey = `actor:issue-714-merge-utf-${'\uE000'}`;
const mergeUtfPeerNodeKey = `actor:issue-714-merge-utf-${'\u{10000}'}`;
const mergeUtfSecondaryNodeKey = 'actor:issue-714-merge-utf-secondary';
const mergeUtfPrimaryActorId = '71400000-0000-0000-0000-000000000026';
const mergeUtfSecondaryActorId = '71400000-0000-0000-0000-000000000027';
const mergeSharedDocumentNodeKey = 'document:issue-714-merge-shared';
const mergeSecondaryOnlyDocumentNodeKey = 'document:issue-714-merge-secondary-only';
const mergeIncomingDocumentNodeKey = 'document:issue-714-merge-incoming';
const mergePrimaryActorId = '71400000-0000-0000-0000-000000000020';
const mergeSecondaryActorId = '71400000-0000-0000-0000-000000000021';

const rollbackPrimaryNodeKey = 'actor:issue-714-rollback-primary';
const rollbackSecondaryNodeKey = 'actor:issue-714-rollback-secondary';
const rollbackDocumentNodeKey = 'document:issue-714-rollback-doc';

await main();

async function main(): Promise<void> {
  try {
    await resetFixtureRows();
    await seedProjects();
    await assertEnsureProjectGraph();
    await assertNodeUpsertPersistsKindSubtypeAndProperties();
    await assertAllEdgeTypesUpsertAndReplaceProperties();
    await assertSameAsReverseUpsertUsesCanonicalPair();
    await assertSameAsUtf8ByteOrderCanonicalization();
    await assertMissingAndCrossProjectEndpointsRejected();
    await assertCountDocumentNodeAndCountRelations();
    await assertFindRelatedDocumentsTraversal();
    await assertReadPresetActorDocumentsContract();
    await assertReadPresetRecentRelationsContract();
    await assertRunGraphPresetQueryWithRelationalReadRepository();
    await assertSyntheticMonitorCountContract();
    await assertDeleteDocumentGraphNodes();
    await resetFixtureRows();
    await seedProjects();
    await seedMergeFixture();
    await assertMergeActorGraphNodes();
    await seedMergeUtfFixture();
    await assertMergeActorGraphNodesUtf8Collation();
    await resetFixtureRows();
    await seedProjects();
    await seedRollbackFixture();
    await assertMergeActorGraphNodesRollback();
    await assertDeleteProjectGraphKeepsProjectRow();
    console.log('relational graph adapter database tests passed');
  } finally {
    try {
      await resetFixtureRows();
    } finally {
      await sql.end();
    }
  }
}

async function assertEnsureProjectGraph(): Promise<void> {
  await mutationRepository.ensureProjectGraph({ projectId });
  await assert.rejects(
    () => mutationRepository.ensureProjectGraph({ projectId: missingProjectId }),
    (error: unknown) => {
      if (!(error instanceof Error)) {
        return false;
      }
      assert.equal(error.message, 'Graph mutation capability unavailable.');
      assert.doesNotMatch(error.message, /714|missing/i);
      return true;
    },
  );
}

async function assertNodeUpsertPersistsKindSubtypeAndProperties(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: seedNodeKey,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: seedDocumentId,
      graphLabels: ['Document'],
      graphNodeId: seedNodeKey,
      title: 'Issue 714 seed document',
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: actorNodeKey,
    labels: ['Actor'],
    projectId,
    properties: {
      actorId: monitorUserId,
      displayName: 'Issue 714 actor',
      graphLabels: ['Actor'],
      graphNodeId: actorNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: topicNodeKey,
    labels: ['Topic'],
    projectId,
    properties: {
      graphLabels: ['Topic'],
      graphNodeId: topicNodeKey,
      topicType: 'keyword',
    },
  });

  const seedRow = await readNodeRow(projectId, seedNodeKey);
  assert.equal(seedRow.kind, 'document');
  assert.equal(seedRow.subtype, 'web_page');
  assert.equal(seedRow.properties.documentId, seedDocumentId);
  assert.equal(seedRow.properties.graphNodeId, seedNodeKey);
  assert.deepEqual(seedRow.properties.graphLabels, ['Document']);

  const actorRow = await readNodeRow(projectId, actorNodeKey);
  assert.equal(actorRow.kind, 'actor');
  assert.equal(actorRow.subtype, 'person');
  assert.equal(actorRow.properties.graphNodeId, actorNodeKey);
  assert.deepEqual(actorRow.properties.graphLabels, ['Actor']);

  const topicRow = await readNodeRow(projectId, topicNodeKey);
  assert.equal(topicRow.kind, 'topic');
  assert.equal(topicRow.subtype, 'keyword');
  assert.equal(topicRow.properties.graphNodeId, topicNodeKey);
  assert.deepEqual(topicRow.properties.graphLabels, ['Topic']);

  const firstUpdatedAt = seedRow.updatedAt;
  await mutationRepository.upsertNode({
    graphNodeId: seedNodeKey,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: seedDocumentId,
      graphLabels: ['Document'],
      graphNodeId: seedNodeKey,
      title: 'Issue 714 seed document replaced',
    },
  });
  const replacedRow = await readNodeRow(projectId, seedNodeKey);
  assert.equal(replacedRow.properties.title, 'Issue 714 seed document replaced');
  assert.notEqual(replacedRow.updatedAt, firstUpdatedAt);
}

async function assertAllEdgeTypesUpsertAndReplaceProperties(): Promise<void> {
  for (const relationType of GRAPH_EDGE_TYPES) {
    const targetNodeKey =
      relationType === 'MENTIONS' || relationType === 'RELATED_TO' || relationType === 'SAME_AS'
        ? topicNodeKey
        : seedNodeKey;
    await mutationRepository.upsertEdge({
      fromGraphNodeId: actorNodeKey,
      projectId,
      properties: { fixture: relationType, revision: 1 },
      relationType,
      toGraphNodeId: targetNodeKey,
    });
  }
  assert.equal(await countEdges(projectId), GRAPH_EDGE_TYPES.length);

  await mutationRepository.upsertEdge({
    fromGraphNodeId: actorNodeKey,
    projectId,
    properties: { fixture: 'SENT', revision: 2 },
    relationType: 'SENT',
    toGraphNodeId: seedNodeKey,
  });
  assert.equal(await countEdges(projectId), GRAPH_EDGE_TYPES.length);
  const sentProperties = await readEdgeProperties({
    projectId,
    relationType: 'SENT',
    sourceNodeKey: actorNodeKey,
    targetNodeKey: seedNodeKey,
  });
  assert.equal(sentProperties.revision, 2);
}

async function assertSameAsReverseUpsertUsesCanonicalPair(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: sameAsNodeKeyA,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: sameAsDocumentIdA,
      graphLabels: ['Document'],
      graphNodeId: sameAsNodeKeyA,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: sameAsNodeKeyB,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: sameAsDocumentIdB,
      graphLabels: ['Document'],
      graphNodeId: sameAsNodeKeyB,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: sameAsNodeKeyB,
    projectId,
    properties: { fixture: 'same-as-reverse' },
    relationType: 'SAME_AS',
    toGraphNodeId: sameAsNodeKeyA,
  });
  assert.equal(
    await countEdgesBetween({
      projectId,
      relationType: 'SAME_AS',
      sourceNodeKey: sameAsNodeKeyA,
      targetNodeKey: sameAsNodeKeyB,
    }),
    1,
  );
  assert.equal(
    await countEdgesBetween({
      projectId,
      relationType: 'SAME_AS',
      sourceNodeKey: sameAsNodeKeyB,
      targetNodeKey: sameAsNodeKeyA,
    }),
    0,
  );
}

async function assertSameAsUtf8ByteOrderCanonicalization(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: sameAsUtfBmpPeerKey,
    labels: ['Actor'],
    projectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000060',
      displayName: 'Issue 714 UTF BMP peer',
      graphLabels: ['Actor'],
      graphNodeId: sameAsUtfBmpPeerKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: sameAsUtfNonBmpPeerKey,
    labels: ['Actor'],
    projectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000061',
      displayName: 'Issue 714 UTF non-BMP peer',
      graphLabels: ['Actor'],
      graphNodeId: sameAsUtfNonBmpPeerKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: sameAsUtfNonBmpPeerKey,
    projectId,
    properties: { fixture: 'utf8-order', weight: 11 },
    relationType: 'SAME_AS',
    toGraphNodeId: sameAsUtfBmpPeerKey,
  });
  assert.equal(
    await countEdgesBetween({
      projectId,
      relationType: 'SAME_AS',
      sourceNodeKey: sameAsUtfBmpPeerKey,
      targetNodeKey: sameAsUtfNonBmpPeerKey,
    }),
    1,
  );
  assert.equal(
    await countEdgesBetween({
      projectId,
      relationType: 'SAME_AS',
      sourceNodeKey: sameAsUtfNonBmpPeerKey,
      targetNodeKey: sameAsUtfBmpPeerKey,
    }),
    0,
  );
  const canonicalEdge = await readEdgeProperties({
    projectId,
    relationType: 'SAME_AS',
    sourceNodeKey: sameAsUtfBmpPeerKey,
    targetNodeKey: sameAsUtfNonBmpPeerKey,
  });
  assert.equal(canonicalEdge.fixture, 'utf8-order');
  assert.equal(canonicalEdge.weight, 11);

  await mutationRepository.upsertEdge({
    fromGraphNodeId: sameAsUtfNonBmpPeerKey,
    projectId,
    properties: { fixture: 'utf8-order-updated', weight: 99 },
    relationType: 'SAME_AS',
    toGraphNodeId: sameAsUtfBmpPeerKey,
  });
  assert.equal(
    await countEdgesBetween({
      projectId,
      relationType: 'SAME_AS',
      sourceNodeKey: sameAsUtfBmpPeerKey,
      targetNodeKey: sameAsUtfNonBmpPeerKey,
    }),
    1,
  );
  const updatedEdge = await readEdgeProperties({
    projectId,
    relationType: 'SAME_AS',
    sourceNodeKey: sameAsUtfBmpPeerKey,
    targetNodeKey: sameAsUtfNonBmpPeerKey,
  });
  assert.equal(updatedEdge.fixture, 'utf8-order-updated');
  assert.equal(updatedEdge.weight, 99);
}

async function assertMissingAndCrossProjectEndpointsRejected(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: otherProjectDocumentNodeKey,
    labels: ['Document'],
    projectId: otherProjectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000099',
      graphLabels: ['Document'],
      graphNodeId: otherProjectDocumentNodeKey,
    },
  });
  const otherProjectEdgeCountBefore = await countEdges(otherProjectId);

  await assert.rejects(
    () =>
      mutationRepository.upsertEdge({
        fromGraphNodeId: 'document:issue-714-missing-source',
        projectId,
        properties: {},
        relationType: 'SENT',
        toGraphNodeId: seedNodeKey,
      }),
    /Graph mutation capability unavailable/,
  );
  await assert.rejects(
    () =>
      mutationRepository.upsertEdge({
        fromGraphNodeId: actorNodeKey,
        projectId,
        properties: {},
        relationType: 'SENT',
        toGraphNodeId: 'document:issue-714-missing-target',
      }),
    /Graph mutation capability unavailable/,
  );
  await assert.rejects(
    () =>
      mutationRepository.upsertEdge({
        fromGraphNodeId: actorNodeKey,
        projectId,
        properties: {},
        relationType: 'SENT',
        toGraphNodeId: otherProjectDocumentNodeKey,
      }),
    /Graph mutation capability unavailable/,
  );

  assert.equal(await countEdges(otherProjectId), otherProjectEdgeCountBefore);
}

async function assertCountDocumentNodeAndCountRelations(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: countRelationsNodeKey,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000008',
      graphLabels: ['Document'],
      graphNodeId: countRelationsNodeKey,
    },
  });

  assert.equal(
    await graphReadRepository.countDocumentNode({
      graphNodeId: seedNodeKey,
      projectId,
    }),
    1,
  );
  assert.equal(
    await graphReadRepository.countDocumentNode({
      graphNodeId: 'document:issue-714-missing',
      projectId,
    }),
    0,
  );

  await mutationRepository.upsertEdge({
    fromGraphNodeId: countRelationsNodeKey,
    projectId,
    properties: { fixture: 'self-loop' },
    relationType: 'SENT',
    toGraphNodeId: countRelationsNodeKey,
  });

  const relationCounts = await graphReadRepository.countRelations({
    graphNodeId: countRelationsNodeKey,
    projectId,
    relationTypes: ['SENT', 'AUTHORED', 'MENTIONS'],
  });
  assert.equal(relationCounts.SENT, 1);
  assert.equal(relationCounts.AUTHORED, 0);
  assert.equal(relationCounts.MENTIONS, 0);

  assert.equal(
    await graphReadRepository.countDocumentNode({
      graphNodeId: seedNodeKey,
      projectId: otherProjectId,
    }),
    0,
  );
}

async function assertFindRelatedDocumentsTraversal(): Promise<void> {
  await seedRelatedDocumentGraph();

  const result = await graphReadRepository.findRelatedDocuments({
    projectId,
    relationLimits: { MENTIONS: 1, RELATED_TO: 2, SAME_AS: 2 },
    seedDocumentIds: [seedDocumentId],
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(
    result.candidates.map((candidate) => ({
      documentId: candidate.documentId,
      hopCount: candidate.hopCount,
      relationType: candidate.relationType,
      seedDocumentId: candidate.seedDocumentId,
    })),
    [
      {
        documentId: sameAsDocumentIdA,
        hopCount: 1,
        relationType: 'SAME_AS',
        seedDocumentId: seedDocumentId,
      },
      {
        documentId: sameAsDocumentIdB,
        hopCount: 1,
        relationType: 'SAME_AS',
        seedDocumentId: seedDocumentId,
      },
      {
        documentId: relatedDocumentIdA,
        hopCount: 1,
        relationType: 'RELATED_TO',
        seedDocumentId: seedDocumentId,
      },
      {
        documentId: relatedDocumentIdB,
        hopCount: 1,
        relationType: 'RELATED_TO',
        seedDocumentId: seedDocumentId,
      },
      {
        documentId: mentionsDocumentId,
        hopCount: 2,
        relationType: 'MENTIONS',
        seedDocumentId: seedDocumentId,
      },
    ],
  );
  assert.ok(result.candidates.every((candidate) => candidate.documentId !== seedDocumentId));
}

async function assertReadPresetActorDocumentsContract(): Promise<void> {
  const result = await graphReadRepository.readPreset({
    documentGraphNodeIds: [seedNodeKey, relatedNodeKeyA],
    presetId: 'actor-documents',
    projectId,
  });
  assert.ok(GRAPH_PRESET_IDS.includes('actor-documents'));
  assert.ok(result.preview.trim().length > 0);
  assert.doesNotMatch(result.preview, /\b(SELECT|FROM|JOIN|MATCH|cypher|agtype)\b/i);
  assert.ok(result.nodes.length > 0);
  assert.ok(result.edges.length > 0);
  assert.ok(result.nodes.every((node) => node.id.length > 0));
  assert.ok(result.edges.every((edge) => edge.source.length > 0 && edge.target.length > 0));
  assert.ok(result.edges.every((edge) => edge.id.length > 0 && edge.label.length > 0));
  assert.equal(result.rowCount, result.rawRows.length);
  assert.equal(typeof result.truncated, 'boolean');
  assert.ok(result.nodes.length <= 600);
  assert.ok(result.edges.length <= 500);
}

async function assertReadPresetRecentRelationsContract(): Promise<void> {
  const result = await graphReadRepository.readPreset({
    documentGraphNodeIds: [seedNodeKey, relatedNodeKeyA, relatedNodeKeyB],
    presetId: 'recent-relations',
    projectId,
  });
  assert.ok(result.preview.trim().length > 0);
  assert.doesNotMatch(result.preview, /\b(SELECT|FROM|JOIN|MATCH|cypher|agtype)\b/i);
  assert.ok(result.nodes.every((node) => node.id.length > 0));
  assert.ok(result.edges.every((edge) => edge.source.length > 0 && edge.target.length > 0));
  assert.equal(result.rowCount, result.rawRows.length);
  assert.ok(result.nodes.length <= 600);
  assert.ok(result.edges.length <= 500);
}

async function assertRunGraphPresetQueryWithRelationalReadRepository(): Promise<void> {
  const viewerRepository = createStubGraphViewerRepository();
  const result = await runGraphPresetQuery(
    {
      limit: 50,
      projectSlug: 'issue-714-relational-graph',
      queryId: 'actor-documents',
      userId: monitorUserId,
    },
    {
      graphReadRepository,
      repository: viewerRepository,
    },
  );
  assert.equal(result.graphName, 'graph_issue_714_relational');
  assert.equal(result.limit, 50);
  assert.equal(result.documentCount, 1);
  assert.ok(result.preset.preview.trim().length > 0);
  assert.doesNotMatch(result.preset.preview, /\b(SELECT|FROM|JOIN|MATCH|cypher|agtype)\b/i);
  assert.ok(result.nodes.length > 0);
  assert.ok(result.edges.length > 0);
  assert.equal(result.rowCount, result.rawRows.length);
}

async function assertSyntheticMonitorCountContract(): Promise<void> {
  // synthetic-monitor-service.test.ts uses createSyntheticMonitorTestGraphReadRepository to adapt
  // countGraphDocumentNode / countGraphRelations onto GraphReadRepository; this DB test verifies
  // the relational adapter satisfies the same countDocumentNode / countRelations contract.
  await seedMonitorFixture();
  assert.equal(
    await graphReadRepository.countDocumentNode({
      graphNodeId: monitorGraphNodeId,
      projectId: monitorProjectId,
    }),
    1,
  );
  assert.deepEqual(
    await graphReadRepository.countRelations({
      graphNodeId: monitorGraphNodeId,
      projectId: monitorProjectId,
      relationTypes: ['SENT'],
    }),
    { SENT: 1 },
  );

  const repository = createPostgresSyntheticMonitorRepository(sql);
  const response = await runSyntheticMonitorObservations({
    allowedProjectSlugs: ['issue-714-relational-monitor'],
    graphReadRepository,
    repository,
    storage: new MemoryObjectStorage(),
    request: {
      projectSlug: 'issue-714-relational-monitor',
      sources: [
        {
          kind: 'gmail',
          threadId: 'thread-714-monitor',
          expectedMessageId: 'message-714-monitor',
          expectedRelations: [{ type: 'SENT', minCount: 1 }],
        },
      ],
    },
  });
  const observation = response.observations[0];
  assert.equal(observation?.graph.status, 'ok');
  assert.equal(observation?.graph.documentNodePresent, true);
  assert.equal(observation?.graph.relations.SENT, 1);
}

async function assertDeleteDocumentGraphNodes(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: unrelatedDocumentNodeKey,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000007',
      graphLabels: ['Document'],
      graphNodeId: unrelatedDocumentNodeKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: seedNodeKey,
    projectId,
    properties: { direction: 'outgoing' },
    relationType: 'SENT',
    toGraphNodeId: unrelatedDocumentNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: unrelatedDocumentNodeKey,
    projectId,
    properties: { direction: 'incoming' },
    relationType: 'MENTIONS',
    toGraphNodeId: topicNodeKey,
  });

  const edgeCountBefore = await countEdges(projectId);
  const deletedCount = await mutationRepository.deleteDocumentGraphNodes({
    graphNodeIds: [seedNodeKey],
    projectId,
  });
  assert.ok(deletedCount >= 1);
  assert.equal(await countNode(projectId, seedNodeKey), 0);
  assert.equal(await countNode(projectId, actorNodeKey), 1);
  assert.equal(await countNode(projectId, topicNodeKey), 1);
  assert.equal(await countNode(otherProjectId, otherProjectDocumentNodeKey), 1);
  assert.equal(await countEdgesForNode(projectId, seedNodeKey), 0);
  assert.ok((await countEdges(projectId)) < edgeCountBefore);
}

async function assertMergeActorGraphNodes(): Promise<void> {
  assert.deepEqual(
    await mutationRepository.mergeActorGraphNodes({
      primaryActorId: mergePrimaryActorId,
      primaryGraphNodeId: mergePrimaryNodeKey,
      projectId: mergeProjectId,
      secondaryGraphNodeId: mergePrimaryNodeKey,
    }),
    {
      reason: 'primary and secondary graph nodes are identical',
      status: 'skipped',
    },
  );
  assert.deepEqual(
    await mutationRepository.mergeActorGraphNodes({
      primaryActorId: mergePrimaryActorId,
      primaryGraphNodeId: mergePrimaryNodeKey,
      projectId: mergeProjectId,
      secondaryGraphNodeId: 'actor:issue-714-merge-missing',
    }),
    {
      reason: 'secondary actor graph node not found',
      status: 'skipped',
    },
  );

  const mergeResult = await mutationRepository.mergeActorGraphNodes({
    primaryActorId: mergePrimaryActorId,
    primaryGraphNodeId: mergePrimaryNodeKey,
    projectId: mergeProjectId,
    secondaryGraphNodeId: mergeSecondaryNodeKey,
  });
  assert.deepEqual(mergeResult, { deletedCount: 1, status: 'merged' });
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

  assert.ok(mergeCollisionPeerNodeKey < mergePrimaryNodeKey);
  assert.equal(
    await countEdgesBetween({
      projectId: mergeProjectId,
      relationType: 'SAME_AS',
      sourceNodeKey: mergeCollisionPeerNodeKey,
      targetNodeKey: mergePrimaryNodeKey,
    }),
    1,
  );
  assert.equal(
    await countEdgesBetween({
      projectId: mergeProjectId,
      relationType: 'SAME_AS',
      sourceNodeKey: mergePrimaryNodeKey,
      targetNodeKey: mergeCollisionPeerNodeKey,
    }),
    0,
  );
  const collisionSameAsEdge = await readEdgeProperties({
    projectId: mergeProjectId,
    relationType: 'SAME_AS',
    sourceNodeKey: mergeCollisionPeerNodeKey,
    targetNodeKey: mergePrimaryNodeKey,
  });
  assert.equal(collisionSameAsEdge.weight, 99);
  assert.equal(collisionSameAsEdge.fixture, 'primary-existing-same-as');

  assert.ok(mergePrimaryNodeKey < mergeCanonicalizationPeerNodeKey);
  assert.ok(mergeCanonicalizationPeerNodeKey < mergeSecondaryNodeKey);
  assert.equal(
    await countEdgesBetween({
      projectId: mergeProjectId,
      relationType: 'SAME_AS',
      sourceNodeKey: mergePrimaryNodeKey,
      targetNodeKey: mergeCanonicalizationPeerNodeKey,
    }),
    1,
  );
  assert.equal(
    await countEdgesBetween({
      projectId: mergeProjectId,
      relationType: 'SAME_AS',
      sourceNodeKey: mergeCanonicalizationPeerNodeKey,
      targetNodeKey: mergePrimaryNodeKey,
    }),
    0,
  );
  assert.equal(await countEdgesForNode(mergeProjectId, mergeSecondaryNodeKey), 0);
  const canonicalizedSameAsEdge = await readEdgeProperties({
    projectId: mergeProjectId,
    relationType: 'SAME_AS',
    sourceNodeKey: mergePrimaryNodeKey,
    targetNodeKey: mergeCanonicalizationPeerNodeKey,
  });
  assert.equal(canonicalizedSameAsEdge.actorId, mergePrimaryActorId);
  assert.equal(canonicalizedSameAsEdge.fixture, 'secondary-same-as-rr');
  assert.equal(canonicalizedSameAsEdge.weight, 7);
}

async function assertMergeActorGraphNodesUtf8Collation(): Promise<void> {
  assert.ok(
    Buffer.from(mergeUtfPrimaryNodeKey, 'utf8').compare(Buffer.from(mergeUtfPeerNodeKey, 'utf8')) <
      0,
  );
  assert.ok(mergeUtfPeerNodeKey < mergeUtfPrimaryNodeKey);

  const mergeResult = await mutationRepository.mergeActorGraphNodes({
    primaryActorId: mergeUtfPrimaryActorId,
    primaryGraphNodeId: mergeUtfPrimaryNodeKey,
    projectId: mergeProjectId,
    secondaryGraphNodeId: mergeUtfSecondaryNodeKey,
  });
  assert.deepEqual(mergeResult, { deletedCount: 1, status: 'merged' });
  assert.equal(await countNode(mergeProjectId, mergeUtfSecondaryNodeKey), 0);
  assert.equal(await countEdgesForNode(mergeProjectId, mergeUtfSecondaryNodeKey), 0);

  assert.equal(
    await countEdgesBetween({
      projectId: mergeProjectId,
      relationType: 'SAME_AS',
      sourceNodeKey: mergeUtfPrimaryNodeKey,
      targetNodeKey: mergeUtfPeerNodeKey,
    }),
    1,
  );
  assert.equal(
    await countEdgesBetween({
      projectId: mergeProjectId,
      relationType: 'SAME_AS',
      sourceNodeKey: mergeUtfPeerNodeKey,
      targetNodeKey: mergeUtfPrimaryNodeKey,
    }),
    0,
  );
  const utfCanonicalSameAsEdge = await readEdgeProperties({
    projectId: mergeProjectId,
    relationType: 'SAME_AS',
    sourceNodeKey: mergeUtfPrimaryNodeKey,
    targetNodeKey: mergeUtfPeerNodeKey,
  });
  assert.equal(utfCanonicalSameAsEdge.actorId, mergeUtfPrimaryActorId);
  assert.equal(utfCanonicalSameAsEdge.fixture, 'secondary-same-as-utf');
  assert.equal(utfCanonicalSameAsEdge.weight, 13);
}

async function assertMergeActorGraphNodesRollback(): Promise<void> {
  const edgeCountBefore = await countEdges(rollbackProjectId);

  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        const boundRepository = createPostgresRelationalGraphMutationRepository(tx);
        await boundRepository.mergeActorGraphNodes({
          primaryActorId: '71400000-0000-0000-0000-000000000030',
          primaryGraphNodeId: rollbackPrimaryNodeKey,
          projectId: rollbackProjectId,
          secondaryGraphNodeId: rollbackSecondaryNodeKey,
        });
        throw new Error('deliberate relational actor merge rollback');
      }),
    /deliberate relational actor merge rollback/,
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

async function assertDeleteProjectGraphKeepsProjectRow(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: seedNodeKey,
    labels: ['Document'],
    projectId,
    properties: {
      docType: 'web_page',
      documentId: seedDocumentId,
      graphLabels: ['Document'],
      graphNodeId: seedNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: otherProjectDocumentNodeKey,
    labels: ['Document'],
    projectId: otherProjectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000099',
      graphLabels: ['Document'],
      graphNodeId: otherProjectDocumentNodeKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: otherProjectDocumentNodeKey,
    projectId: otherProjectId,
    properties: { fixture: 'other-project-self' },
    relationType: 'RELATED_TO',
    toGraphNodeId: otherProjectDocumentNodeKey,
  });

  const otherProjectNodeCountBefore = await countNodes(otherProjectId);
  const otherProjectEdgeCountBefore = await countEdges(otherProjectId);
  assert.ok((await countNodes(projectId)) > 0);
  assert.ok((await countEdges(projectId)) >= 0);

  await mutationRepository.deleteProjectGraph({ projectId });

  assert.equal(await countNodes(projectId), 0);
  assert.equal(await countEdges(projectId), 0);
  assert.equal(await countProject(projectId), 1);
  assert.equal(await countNodes(otherProjectId), otherProjectNodeCountBefore);
  assert.equal(await countEdges(otherProjectId), otherProjectEdgeCountBefore);
}

async function seedRelatedDocumentGraph(): Promise<void> {
  const documentNodes = [
    {
      documentId: sameAsDocumentIdA,
      graphNodeId: sameAsNodeKeyA,
      nodeKey: sameAsNodeKeyA,
    },
    {
      documentId: sameAsDocumentIdB,
      graphNodeId: sameAsNodeKeyB,
      nodeKey: sameAsNodeKeyB,
    },
    {
      documentId: relatedDocumentIdA,
      graphNodeId: relatedNodeKeyA,
      nodeKey: relatedNodeKeyA,
    },
    {
      documentId: relatedDocumentIdB,
      graphNodeId: relatedNodeKeyB,
      nodeKey: relatedNodeKeyB,
    },
    {
      documentId: mentionsDocumentId,
      graphNodeId: mentionsNodeKey,
      nodeKey: mentionsNodeKey,
    },
  ];

  for (const documentNode of documentNodes) {
    await mutationRepository.upsertNode({
      graphNodeId: documentNode.graphNodeId,
      labels: ['Document'],
      projectId,
      properties: {
        docType: 'web_page',
        documentId: documentNode.documentId,
        graphLabels: ['Document'],
        graphNodeId: documentNode.graphNodeId,
      },
    });
  }

  await mutationRepository.upsertEdge({
    fromGraphNodeId: seedNodeKey,
    projectId,
    properties: { fixture: 'same-as-a' },
    relationType: 'SAME_AS',
    toGraphNodeId: sameAsNodeKeyA,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: seedNodeKey,
    projectId,
    properties: { fixture: 'same-as-b' },
    relationType: 'SAME_AS',
    toGraphNodeId: sameAsNodeKeyB,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: seedNodeKey,
    projectId,
    properties: { fixture: 'related-a' },
    relationType: 'RELATED_TO',
    toGraphNodeId: relatedNodeKeyA,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: relatedNodeKeyB,
    projectId,
    properties: { fixture: 'related-b' },
    relationType: 'RELATED_TO',
    toGraphNodeId: seedNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: seedNodeKey,
    projectId,
    properties: { fixture: 'mentions-seed' },
    relationType: 'MENTIONS',
    toGraphNodeId: topicNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mentionsNodeKey,
    projectId,
    properties: { fixture: 'mentions-related' },
    relationType: 'MENTIONS',
    toGraphNodeId: topicNodeKey,
  });
}

async function seedMonitorFixture(): Promise<void> {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${monitorProjectId},
      'issue-714-relational-monitor',
      'Issue 714 Relational Monitor',
      'graph_issue_714_relational_monitor',
      'issue-714-relational-monitor',
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (
      ${monitorUserId},
      'issue-714-monitor@example.test',
      'Issue 714 Monitor User',
      'admin'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES (${monitorProjectId}, ${monitorUserId}, 'admin')
    ON CONFLICT (project_id, user_id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_sources (
      id, project_id, owner_user_id, source_type, name, config, ingest_window
    )
    VALUES (
      ${monitorDataSourceId},
      ${monitorProjectId},
      ${monitorUserId},
      'gmail',
      'Issue 714 Monitor Gmail',
      ${sql.json({ fixture: true })},
      ${sql.json({})}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.raw_documents (
      id,
      project_id,
      source_type,
      source_id,
      logical_source_id,
      source_version,
      storage_uri,
      content_hash,
      ingest_status,
      fetched_at
    )
    VALUES (
      ${monitorRawDocumentId},
      ${monitorProjectId},
      'gmail',
      'issue-714-monitor-source',
      'thread-714-monitor',
      'message-714-monitor',
      'raw/issue-714-monitor.json',
      'issue-714-monitor-hash',
      'indexed',
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.raw_document_data_sources (
      raw_document_id, data_source_id, project_id
    )
    VALUES (${monitorRawDocumentId}, ${monitorDataSourceId}, ${monitorProjectId})
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_source_schedules (
      project_id, data_source_id, enabled, next_run_at
    )
    VALUES (
      ${monitorProjectId},
      ${monitorDataSourceId},
      true,
      '2099-01-01T01:00:00.000Z'::timestamptz
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO public.documents (
      id,
      project_id,
      raw_document_id,
      doc_type,
      logical_source_id,
      title,
      summary,
      canonical_uri,
      graph_node_id
    )
    VALUES (
      ${monitorDocumentId},
      ${monitorProjectId},
      ${monitorRawDocumentId},
      'email',
      'thread-714-monitor',
      'Issue 714 monitor document',
      'monitor summary',
      'mailto:issue-714-monitor@example.test',
      ${monitorGraphNodeId}
    )
    ON CONFLICT (id) DO UPDATE SET graph_node_id = EXCLUDED.graph_node_id
  `;
  const embedding = [1, ...Array.from({ length: 1535 }, () => 0)];
  const vector = `[${embedding.join(',')}]`;
  await sql.unsafe(
    `INSERT INTO public.document_chunks (
      project_id, document_id, chunk_index, content, content_hash, embedding, embedding_model
    )
    VALUES ($1::uuid, $2::uuid, 0, 'fixture chunk', 'issue-714-monitor-chunk', $3::vector, 'gemini-test')
    ON CONFLICT DO NOTHING`,
    [monitorProjectId, monitorDocumentId, vector],
  );
  await mutationRepository.upsertNode({
    graphNodeId: monitorGraphNodeId,
    labels: ['Document'],
    projectId: monitorProjectId,
    properties: {
      docType: 'email',
      documentId: monitorDocumentId,
      graphLabels: ['Document'],
      graphNodeId: monitorGraphNodeId,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: actorNodeKey,
    labels: ['Actor'],
    projectId: monitorProjectId,
    properties: {
      actorId: monitorUserId,
      displayName: 'Issue 714 monitor actor',
      graphLabels: ['Actor'],
      graphNodeId: actorNodeKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: actorNodeKey,
    projectId: monitorProjectId,
    properties: { actorId: monitorUserId },
    relationType: 'SENT',
    toGraphNodeId: monitorGraphNodeId,
  });
}

function createStubGraphViewerRepository(): GraphViewerRepository {
  return {
    async fetchDocumentChunks() {
      return new Map();
    },
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'issue-714-relational-graph' && userId === monitorUserId
        ? {
            graphName: 'graph_issue_714_relational',
            id: projectId,
            name: 'Issue 714 Relational Graph',
            slug: 'issue-714-relational-graph',
          }
        : undefined;
    },
    async lookupPublicProject() {
      return undefined;
    },
    async selectEligibleDocumentGraphNodeIds({ projectId: scopedProjectId }) {
      assert.equal(scopedProjectId, projectId);
      return [seedNodeKey];
    },
  };
}

async function seedProjects(): Promise<void> {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES
      (
        ${projectId},
        'issue-714-relational-graph',
        'Issue 714 Relational Graph',
        'graph_issue_714_relational',
        'issue-714-relational-graph',
        'private'
      ),
      (
        ${otherProjectId},
        'issue-714-relational-other',
        'Issue 714 Relational Other',
        'graph_issue_714_relational_other',
        'issue-714-relational-other',
        'private'
      ),
      (
        ${mergeProjectId},
        'issue-714-relational-merge',
        'Issue 714 Relational Merge',
        'graph_issue_714_relational_merge',
        'issue-714-relational-merge',
        'private'
      ),
      (
        ${rollbackProjectId},
        'issue-714-relational-rollback',
        'Issue 714 Relational Rollback',
        'graph_issue_714_relational_rollback',
        'issue-714-relational-rollback',
        'private'
      ),
      (
        ${monitorProjectId},
        'issue-714-relational-monitor',
        'Issue 714 Relational Monitor',
        'graph_issue_714_relational_monitor',
        'issue-714-relational-monitor',
        'private'
      )
  `;
}

async function seedMergeFixture(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: mergePrimaryNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: mergePrimaryActorId,
      displayName: 'Issue 714 merge primary',
      graphLabels: ['Actor'],
      graphNodeId: mergePrimaryNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeSecondaryNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: mergeSecondaryActorId,
      displayName: 'Issue 714 merge secondary',
      graphLabels: ['Actor'],
      graphNodeId: mergeSecondaryNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeCollisionPeerNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000022',
      displayName: 'Issue 714 merge collision peer',
      graphLabels: ['Actor'],
      graphNodeId: mergeCollisionPeerNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeCanonicalizationPeerNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000023',
      displayName: 'Issue 714 merge canonicalization peer',
      graphLabels: ['Actor'],
      graphNodeId: mergeCanonicalizationPeerNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeSharedDocumentNodeKey,
    labels: ['Document'],
    projectId: mergeProjectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000040',
      graphLabels: ['Document'],
      graphNodeId: mergeSharedDocumentNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeSecondaryOnlyDocumentNodeKey,
    labels: ['Document'],
    projectId: mergeProjectId,
    properties: {
      docType: 'email',
      documentId: '71400000-0000-0000-0000-000000000041',
      graphLabels: ['Document'],
      graphNodeId: mergeSecondaryOnlyDocumentNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeIncomingDocumentNodeKey,
    labels: ['Document'],
    projectId: mergeProjectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000042',
      graphLabels: ['Document'],
      graphNodeId: mergeIncomingDocumentNodeKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergePrimaryNodeKey,
    projectId: mergeProjectId,
    properties: { actorId: mergePrimaryActorId, fixture: 'primary-existing-same-as', weight: 99 },
    relationType: 'SAME_AS',
    toGraphNodeId: mergeCollisionPeerNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergeSecondaryNodeKey,
    projectId: mergeProjectId,
    properties: { actorId: mergeSecondaryActorId, fixture: 'secondary-same-as-rr', weight: 7 },
    relationType: 'SAME_AS',
    toGraphNodeId: mergeCanonicalizationPeerNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergePrimaryNodeKey,
    projectId: mergeProjectId,
    properties: { actorId: mergePrimaryActorId, weight: 42 },
    relationType: 'AUTHORED',
    toGraphNodeId: mergeSharedDocumentNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergeSecondaryNodeKey,
    projectId: mergeProjectId,
    properties: { actorId: mergeSecondaryActorId, weight: 7 },
    relationType: 'AUTHORED',
    toGraphNodeId: mergeSharedDocumentNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergeSecondaryNodeKey,
    projectId: mergeProjectId,
    properties: { actorId: mergeSecondaryActorId, channel: 'secondary-only' },
    relationType: 'SENT',
    toGraphNodeId: mergeSecondaryOnlyDocumentNodeKey,
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergeIncomingDocumentNodeKey,
    projectId: mergeProjectId,
    properties: { fixture: 'incoming' },
    relationType: 'MENTIONS',
    toGraphNodeId: mergeSecondaryNodeKey,
  });
}

async function seedMergeUtfFixture(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: mergeUtfPrimaryNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: mergeUtfPrimaryActorId,
      displayName: 'Issue 714 merge UTF primary',
      graphLabels: ['Actor'],
      graphNodeId: mergeUtfPrimaryNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeUtfPeerNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000028',
      displayName: 'Issue 714 merge UTF peer',
      graphLabels: ['Actor'],
      graphNodeId: mergeUtfPeerNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: mergeUtfSecondaryNodeKey,
    labels: ['Actor'],
    projectId: mergeProjectId,
    properties: {
      actorId: mergeUtfSecondaryActorId,
      displayName: 'Issue 714 merge UTF secondary',
      graphLabels: ['Actor'],
      graphNodeId: mergeUtfSecondaryNodeKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: mergeUtfSecondaryNodeKey,
    projectId: mergeProjectId,
    properties: {
      actorId: mergeUtfSecondaryActorId,
      fixture: 'secondary-same-as-utf',
      weight: 13,
    },
    relationType: 'SAME_AS',
    toGraphNodeId: mergeUtfPeerNodeKey,
  });
}

async function seedRollbackFixture(): Promise<void> {
  await mutationRepository.upsertNode({
    graphNodeId: rollbackPrimaryNodeKey,
    labels: ['Actor'],
    projectId: rollbackProjectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000030',
      displayName: 'Issue 714 rollback primary',
      graphLabels: ['Actor'],
      graphNodeId: rollbackPrimaryNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: rollbackSecondaryNodeKey,
    labels: ['Actor'],
    projectId: rollbackProjectId,
    properties: {
      actorId: '71400000-0000-0000-0000-000000000031',
      displayName: 'Issue 714 rollback secondary',
      graphLabels: ['Actor'],
      graphNodeId: rollbackSecondaryNodeKey,
    },
  });
  await mutationRepository.upsertNode({
    graphNodeId: rollbackDocumentNodeKey,
    labels: ['Document'],
    projectId: rollbackProjectId,
    properties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000032',
      graphLabels: ['Document'],
      graphNodeId: rollbackDocumentNodeKey,
    },
  });
  await mutationRepository.upsertEdge({
    fromGraphNodeId: rollbackSecondaryNodeKey,
    projectId: rollbackProjectId,
    properties: { actorId: '71400000-0000-0000-0000-000000000031' },
    relationType: 'AUTHORED',
    toGraphNodeId: rollbackDocumentNodeKey,
  });
}

async function readNodeRow(
  targetProjectId: string,
  nodeKey: string,
): Promise<{
  kind: string;
  properties: Record<string, unknown>;
  subtype: string | null;
  updatedAt: string;
}> {
  const rows = (await sql`
    SELECT kind, subtype, properties, updated_at AS "updatedAt"
    FROM public.graph_nodes
    WHERE project_id = ${targetProjectId}
      AND node_key = ${nodeKey}
  `) as readonly unknown[];
  const row = singleRow(rows);
  const properties = requireJsonObjectField(row, 'properties');
  return {
    kind: stringField(row, 'kind'),
    properties,
    subtype: nullableStringField(row, 'subtype'),
    updatedAt: timestampField(row, 'updatedAt'),
  };
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
  const properties = requireJsonObjectField(singleRow(rows), 'properties');
  return properties;
}

async function countProject(targetProjectId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.projects
    WHERE id = ${targetProjectId}
  `) as readonly unknown[];
  return numberField(singleRow(rows), 'count');
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

async function resetFixtureRows(): Promise<void> {
  await sql`DELETE FROM public.graph_edges WHERE project_id IN (${projectId}, ${otherProjectId}, ${mergeProjectId}, ${rollbackProjectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.graph_nodes WHERE project_id IN (${projectId}, ${otherProjectId}, ${mergeProjectId}, ${rollbackProjectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.document_chunks WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.documents WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.raw_document_data_sources WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.data_source_schedules WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.raw_documents WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.data_sources WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.project_members WHERE project_id IN (${projectId}, ${monitorProjectId})`;
  await sql`DELETE FROM public.users WHERE id = ${monitorUserId}`;
  await sql`DELETE FROM public.projects WHERE id IN (${projectId}, ${otherProjectId}, ${mergeProjectId}, ${rollbackProjectId}, ${monitorProjectId})`;
}
