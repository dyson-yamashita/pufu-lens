import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import {
  createPostgresChatRepository,
  GRAPH_RELATION_POOL_LIMITS,
  queryGraphRelatedDocumentIds,
} from './chat.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for graph coverage database tests.');
}

const sql = postgres(databaseUrl, { max: 1 });
const projectId = '10000000-0000-0000-0000-000000000648';
const graphName = 'graph_issue_648_coverage';
const seedDocumentId = '10000000-0000-0000-0000-0000000006481';
const sameAsDocumentIds = [
  '10000000-0000-0000-0000-0000000006482',
  '10000000-0000-0000-0000-0000000006483',
  '10000000-0000-0000-0000-0000000006484',
];
const relatedDocumentIds = [
  '10000000-0000-0000-0000-0000000006485',
  '10000000-0000-0000-0000-0000000006486',
];
const mentionsDocumentId = '10000000-0000-0000-0000-0000000006487';
const topicNodeId = 'topic:keyword:graph-coverage';

await main();

async function main() {
  try {
    await resetFixture();
    await ensureGraph(graphName);
    await seedGraphVertices();
    const candidates = await queryGraphRelatedDocumentIds(sql, {
      graphName,
      projectId,
      seedDocumentIds: [seedDocumentId],
    });
    assert.equal(
      candidates.filter((candidate) => candidate.relationType === 'SAME_AS').length,
      GRAPH_RELATION_POOL_LIMITS.SAME_AS,
    );
    assert.equal(
      candidates.filter((candidate) => candidate.relationType === 'RELATED_TO').length,
      relatedDocumentIds.length,
    );
    assert.equal(candidates.filter((candidate) => candidate.relationType === 'MENTIONS').length, 1);
    assert.ok(
      candidates.every(
        (candidate) =>
          candidate.seedDocumentId === seedDocumentId && candidate.documentId !== seedDocumentId,
      ),
    );
    await assertUndirectedMatchFindsDirectedEdges();
    await assertGraphQueryWithStatusFallback();
    console.log('graph coverage database tests passed');
  } finally {
    try {
      await resetFixture();
      await deleteGraphIfExists(graphName);
    } finally {
      await sql.end();
    }
  }
}

async function resetFixture(): Promise<void> {
  await sql`DELETE FROM public.projects WHERE id = ${projectId}`;
}

async function ensureGraph(targetGraphName: string): Promise<void> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  await sql.unsafe(
    `SELECT create_graph(${sqlString(targetGraphName)}) WHERE NOT EXISTS (
      SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(targetGraphName)}
    )`,
  );
}

async function deleteGraphIfExists(targetGraphName: string): Promise<void> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  await sql.unsafe(
    `SELECT drop_graph(${sqlString(targetGraphName)}, true) WHERE EXISTS (
      SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(targetGraphName)}
    )`,
  );
}

async function seedGraphVertices(): Promise<void> {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${projectId},
      'issue-648-graph-coverage',
      'Issue 648 Graph Coverage',
      ${graphName},
      'issue-648-graph-coverage',
      'private'
    )
  `;

  const documentIds = [
    seedDocumentId,
    ...sameAsDocumentIds,
    ...relatedDocumentIds,
    mentionsDocumentId,
  ];
  for (const documentId of documentIds) {
    await runCypher(
      graphName,
      `CREATE (:Document {
        projectId: $projectId,
        documentId: $documentId,
        graphNodeId: $graphNodeId
      })`,
      {
        documentId,
        graphNodeId: `node-${documentId}`,
        projectId,
      },
    );
  }
  await runCypher(
    graphName,
    `CREATE (:Topic {
      projectId: $projectId,
      topicNodeId: $topicNodeId
    })`,
    { projectId, topicNodeId },
  );

  for (const documentId of sameAsDocumentIds) {
    await runCypher(
      graphName,
      `MATCH (seed:Document {documentId: $seedDocumentId}), (related:Document {documentId: $relatedDocumentId})
       CREATE (seed)-[:SAME_AS]->(related)`,
      { relatedDocumentId: documentId, seedDocumentId },
    );
  }
  for (const documentId of relatedDocumentIds) {
    await runCypher(
      graphName,
      `MATCH (seed:Document {documentId: $seedDocumentId}), (related:Document {documentId: $relatedDocumentId})
       CREATE (seed)-[:RELATED_TO]->(related)`,
      { relatedDocumentId: documentId, seedDocumentId },
    );
  }
  await runCypher(
    graphName,
    `MATCH (seed:Document {documentId: $seedDocumentId}), (topic:Topic {topicNodeId: $topicNodeId}), (related:Document {documentId: $relatedDocumentId})
     CREATE (seed)-[:MENTIONS]->(topic), (related)-[:MENTIONS]->(topic)`,
    {
      relatedDocumentId: mentionsDocumentId,
      seedDocumentId,
      topicNodeId,
    },
  );
}

async function assertUndirectedMatchFindsDirectedEdges(): Promise<void> {
  const sameAsCandidates = await queryGraphRelatedDocumentIds(sql, {
    graphName,
    projectId,
    relationLimits: { MENTIONS: 0, RELATED_TO: 0, SAME_AS: 1 },
    seedDocumentIds: [seedDocumentId],
  });
  assert.equal(sameAsCandidates.length, 1);
  assert.equal(sameAsCandidates[0]?.relationType, 'SAME_AS');
}

async function assertGraphQueryWithStatusFallback(): Promise<void> {
  const documentId = '10000000-0000-0000-0000-000000000649';
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
      ingest_status
    )
    VALUES (
      ${documentId},
      ${projectId},
      'web',
      'issue-648-fallback',
      'issue-648-fallback',
      'issue-648-fallback-v1',
      'raw/issue-648-fallback.json',
      'issue-648-fallback-hash',
      'indexed'
    )
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
      ${documentId},
      ${projectId},
      ${documentId},
      'web_page',
      'issue-648-fallback',
      'Issue 648 Graph Coverage fallback title',
      'fallback summary for graph query',
      'https://example.test/issue-648-fallback',
      ${`node-${documentId}`}
    )
  `;
  const repository = createPostgresChatRepository(sql);
  const traversalMiss = await repository.graphQueryWithStatus({
    graphName,
    limit: 3,
    projectId,
    query: 'Issue 648 Graph Coverage fallback title',
    seedDocumentIds: ['10000000-0000-0000-0000-000000099999'],
  });
  assert.equal(traversalMiss.status, 'fallback');
  assert.ok(traversalMiss.sources.some((source) => source.documentId === documentId));
  await sql`DELETE FROM public.documents WHERE id = ${documentId}`;
  await sql`DELETE FROM public.raw_documents WHERE id = ${documentId}`;
}

async function runCypher(
  targetGraphName: string,
  cypher: string,
  params: Record<string, string>,
): Promise<void> {
  await sql`LOAD 'age'`;
  await sql`SET search_path = ag_catalog, "$user", public`;
  await sql.unsafe(
    `SELECT * FROM cypher(${sqlString(targetGraphName)}, ${dollarQuote(cypher)}, $1::agtype) AS (value agtype)`,
    [JSON.stringify(params)],
  );
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}
