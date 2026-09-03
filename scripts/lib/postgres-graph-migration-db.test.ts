import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPostgresAgeGraphMutationRepository } from '@pufu-lens/graph/postgres-age-mutation';
import { createPostgresRelationalGraphMutationRepository } from '@pufu-lens/graph/postgres-relational-mutation';
import type { ObjectInfo, ObjectStorage } from '@pufu-lens/storage';
import postgres from 'postgres';
import { runGraphCompare, runGraphRebuild } from './postgres-graph-migration.ts';
import { auditGraphSourceOfTruth } from './postgres-graph-source-audit.ts';

const execFileAsync = promisify(execFile);
const graphMigrationScript = fileURLToPath(new URL('../graph-migration.ts', import.meta.url));
const databaseUrl = process.env.DATABASE_URL?.trim();

const fixture = {
  actorGraphNodeId: 'actor:github:fixture-author',
  compareActorGraphNodeId: 'actor:github:fixture-compare-author',
  compareDocumentGraphNodeId: 'document:issue:example-org%2Fpufu-sample%2Fissues%2F716-compare',
  compareDocumentId: '20000000-0000-0000-0000-000000000710',
  dataSourceId: '20000000-0000-0000-0000-000000000701',
  documentGraphNodeId: 'document:issue:example-org%2Fpufu-sample%2Fissues%2F716',
  documentId: '20000000-0000-0000-0000-000000000705',
  invalidParsedUri: 'issue-716-rebuild/parsed/invalid-github-issue.json',
  parsedUri: 'issue-716-rebuild/parsed/github-issue.json',
  projectId: '20000000-0000-0000-0000-000000000702',
  projectSlug: 'issue-716-rebuild-graph',
  rawDocumentId: '20000000-0000-0000-0000-000000000701',
  rawDocumentIdInvalid: '20000000-0000-0000-0000-000000000703',
  sentinelNodeKey: 'document:issue:sentinel-project-node',
  sentinelProjectId: '20000000-0000-0000-0000-000000000711',
  sentinelProjectSlug: 'issue-716-rebuild-sentinel',
  userId: '20000000-0000-0000-0000-000000000704',
} as const;

const parsedDocument = JSON.stringify({
  actors: [{ displayName: 'Fixture Author', githubLogin: 'fixture-author', role: 'author' }],
  bodyText: 'Fixture body',
  canonicalUri: 'https://github.com/example-org/pufu-sample/issues/716',
  docType: 'issue',
  metadata: {},
  occurredAt: '2026-05-01T09:00:00.000Z',
  relations: [],
  schemaVersion: 1,
  sourceId: 'example-org/pufu-sample/issues/716',
  sourceType: 'github',
  title: 'Graph rebuild fixture',
});

test('runGraphRebuild dry-run does not write relational graph rows or mutate ingestion state', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  const storage = createInMemoryStorage();
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    const before = await readIngestionSnapshot(sql, fixture.rawDocumentId);

    const beforeNodes = await countGraphNodes(sql, fixture.projectId);
    const result = await runGraphRebuild({
      dryRun: true,
      limit: 10,
      projectSlug: fixture.projectSlug,
      sql,
      storage,
    });
    const afterNodes = await countGraphNodes(sql, fixture.projectId);
    const after = await readIngestionSnapshot(sql, fixture.rawDocumentId);
    const emailQuoteCount = await countEmailQuotes(sql, fixture.projectId);

    assert.equal(beforeNodes, 0);
    assert.equal(afterNodes, 0);
    assert.equal(result.dryRun, true);
    assert.equal(result.processedCount, 1);
    assert.equal(typeof result.nextResumeCursor, 'string');
    assert.equal(JSON.stringify(result).includes(fixture.rawDocumentId), false);
    assert.deepEqual(after, before);
    assert.equal(emailQuoteCount, 0);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('runGraphRebuild execute is idempotent when resume cursor advances', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  const storage = createInMemoryStorage();
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    const before = await readIngestionSnapshot(sql, fixture.rawDocumentId);

    const first = await runGraphRebuild({
      dryRun: false,
      limit: 1,
      projectSlug: fixture.projectSlug,
      sql,
      storage,
    });
    const second = await runGraphRebuild({
      dryRun: false,
      limit: 1,
      projectSlug: fixture.projectSlug,
      resumeCursor: first.nextResumeCursor,
      sql,
      storage,
    });
    const after = await readIngestionSnapshot(sql, fixture.rawDocumentId);

    assert.equal(first.processedCount, 1);
    assert.equal(first.failedCount, 0);
    assert.equal(first.nextResumeCursor, digest(fixture.rawDocumentId));
    assert.equal(second.processedCount, 0);
    assert.equal(second.nodeCount, 0);
    assert.deepEqual(after, before);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('runGraphRebuild execute rolls back when a later target fails', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  const storage = createInMemoryStorage({
    [fixture.invalidParsedUri]: '{ invalid json',
  });
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    await seedInvalidSecondDocument(sql);

    await assert.rejects(
      () =>
        runGraphRebuild({
          dryRun: false,
          limit: 2,
          projectSlug: fixture.projectSlug,
          sql,
          storage,
        }),
      /Graph rebuild batch failed\./,
    );

    assert.equal(await countGraphNodes(sql, fixture.projectId), 0);
    assert.equal(await countGraphEdges(sql, fixture.projectId), 0);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('runGraphRebuild execute does not alter an isolated sentinel project', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  const storage = createInMemoryStorage();
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    await seedSentinelProject(sql);

    await runGraphRebuild({
      dryRun: false,
      limit: 1,
      projectSlug: fixture.projectSlug,
      sql,
      storage,
    });

    assert.equal(await countGraphNodes(sql, fixture.sentinelProjectId), 1);
    assert.equal(await hasGraphNode(sql, fixture.sentinelProjectId, fixture.sentinelNodeKey), true);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('graph-migration compare succeeds without object storage configuration', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    await seedCompareParityGraph(sql);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        graphMigrationScript,
        'compare',
        '--project',
        fixture.projectSlug,
        '--limit',
        '100',
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          GCS_BUCKET: undefined,
          LOCAL_STORAGE_ROOT: undefined,
          OBJECT_STORAGE_DRIVER: undefined,
          STORAGE_BUCKET: undefined,
          STORAGE_DRIVER: undefined,
          STORAGE_ROOT: undefined,
        },
        timeout: 30_000,
      },
    );

    const parsed: unknown = JSON.parse(stdout);
    assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
    assert.ok('gateStatus' in parsed);
    assert.equal(parsed.gateStatus, 'pass');
    assert.equal(stdout.includes(fixture.projectId), false);
    assert.equal(stdout.includes(fixture.compareDocumentGraphNodeId), false);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('runGraphCompare passes for matching AGE and relational synthetic inventories', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    await seedCompareParityGraph(sql);

    const result = await runGraphCompare({
      limit: 100,
      projectSlug: fixture.projectSlug,
      sql,
    });

    assert.equal(result.gateStatus, 'pass');
    assert.equal(JSON.stringify(result).includes(fixture.projectId), false);
    assert.equal(JSON.stringify(result).includes(fixture.compareDocumentGraphNodeId), false);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

test('auditGraphSourceOfTruth parses summary counts without returning identities', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedFixture(sql);
    const audit = await auditGraphSourceOfTruth(sql, fixture.projectId);
    assert.equal(audit.currentDocumentMissingParsedOrStatus, 0);
    assert.equal(audit.relationalDocumentNodeWithoutDocumentRow, 0);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

async function seedCompareParityGraph(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.raw_documents (
      id,
      project_id,
      source_type,
      source_id,
      logical_source_id,
      source_version,
      storage_uri,
      parsed_uri,
      content_hash,
      ingest_status,
      parsed_at
    )
    VALUES (
      '20000000-0000-0000-0000-000000000713',
      ${fixture.projectId},
      'github',
      'example-org/pufu-sample/issues/716-compare',
      'example-org/pufu-sample/issues/716-compare',
      'v1',
      'issue-716-rebuild/raw/github-issue-compare.json',
      ${fixture.parsedUri},
      ${digest('fixture-compare-content')},
      'parsed',
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.documents (
      id,
      project_id,
      raw_document_id,
      logical_source_id,
      doc_type,
      graph_node_id
    )
    VALUES (
      ${fixture.compareDocumentId},
      ${fixture.projectId},
      '20000000-0000-0000-0000-000000000713',
      'example-org/pufu-sample/issues/716-compare',
      'issue',
      ${fixture.compareDocumentGraphNodeId}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  const ageRepository = createPostgresAgeGraphMutationRepository(sql);
  const relationalRepository = createPostgresRelationalGraphMutationRepository(sql);
  await ageRepository.ensureProjectGraph({ projectId: fixture.projectId });
  const documentNode = {
    graphNodeId: fixture.compareDocumentGraphNodeId,
    labels: ['Document', 'Issue'] as const,
    projectId: fixture.projectId,
    properties: {
      docType: 'issue',
      documentId: fixture.compareDocumentId,
      graphNodeId: fixture.compareDocumentGraphNodeId,
      projectId: fixture.projectId,
    },
  };
  const actorNode = {
    graphNodeId: fixture.compareActorGraphNodeId,
    labels: ['Actor'] as const,
    projectId: fixture.projectId,
    properties: {
      actorId: '20000000-0000-0000-0000-000000000712',
      displayName: 'Compare Author',
      graphNodeId: fixture.compareActorGraphNodeId,
      projectId: fixture.projectId,
    },
  };
  const edge = {
    fromGraphNodeId: fixture.compareActorGraphNodeId,
    projectId: fixture.projectId,
    properties: { projectId: fixture.projectId, role: 'author' },
    relationType: 'AUTHORED' as const,
    toGraphNodeId: fixture.compareDocumentGraphNodeId,
  };
  await ageRepository.upsertNode(documentNode);
  await ageRepository.upsertNode(actorNode);
  await ageRepository.upsertEdge(edge);
  await relationalRepository.upsertNode(documentNode);
  await relationalRepository.upsertNode(actorNode);
  await relationalRepository.upsertEdge(edge);
}

async function seedInvalidSecondDocument(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.raw_documents (
      id,
      project_id,
      source_type,
      source_id,
      logical_source_id,
      source_version,
      storage_uri,
      parsed_uri,
      content_hash,
      ingest_status,
      parsed_at
    )
    VALUES (
      ${fixture.rawDocumentIdInvalid},
      ${fixture.projectId},
      'github',
      'example-org/pufu-sample/issues/717',
      'example-org/pufu-sample/issues/717',
      'v1',
      'issue-716-rebuild/raw/github-issue-717.json',
      ${fixture.invalidParsedUri},
      ${digest('fixture-content-invalid')},
      'parsed',
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.documents (
      id,
      project_id,
      raw_document_id,
      logical_source_id,
      doc_type,
      graph_node_id
    )
    VALUES (
      '20000000-0000-0000-0000-000000000709',
      ${fixture.projectId},
      ${fixture.rawDocumentIdInvalid},
      'example-org/pufu-sample/issues/717',
      'issue',
      'document:issue:example-org%2Fpufu-sample%2Fissues%2F717'
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedSentinelProject(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixture.sentinelProjectId},
      ${fixture.sentinelProjectSlug},
      'Issue 716 Rebuild Sentinel',
      'graph_issue_716_rebuild_sentinel',
      'issue-716-rebuild-sentinel',
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.graph_nodes (
      project_id, node_key, kind, subtype, properties
    )
    VALUES (
      ${fixture.sentinelProjectId},
      ${fixture.sentinelNodeKey},
      'document',
      'issue',
      ${sql.json({
        docType: 'issue',
        graphLabels: ['Document', 'Issue'],
        graphNodeId: fixture.sentinelNodeKey,
        projectId: fixture.sentinelProjectId,
      })}
    )
    ON CONFLICT (project_id, node_key) DO NOTHING
  `;
}

function createInMemoryStorage(extraObjects: Record<string, string> = {}): ObjectStorage {
  const objects = new Map<string, string>([
    [fixture.parsedUri, parsedDocument],
    ...Object.entries(extraObjects),
  ]);
  return {
    async exists(): Promise<boolean> {
      return false;
    },
    async get(): Promise<NodeJS.ReadableStream> {
      throw new Error('Not implemented.');
    },
    async getText(uri: string): Promise<string> {
      const value = objects.get(uri);
      if (!value) {
        throw new Error('Object not found.');
      }
      return value;
    },
    async *list(_prefix: string): AsyncIterable<ObjectInfo> {},
    async put(): Promise<{ uri: string }> {
      throw new Error('Not implemented.');
    },
  };
}

async function seedFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${fixture.userId}, 'issue-716-rebuild@example.test', 'Issue 716 Rebuild', 'admin')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixture.projectId},
      ${fixture.projectSlug},
      'Issue 716 Rebuild Graph',
      'graph_issue_716_rebuild',
      'issue-716-rebuild-graph',
      'private'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.data_sources (
      id, project_id, owner_user_id, source_type, name, config, enabled
    )
    VALUES (
      ${fixture.dataSourceId},
      ${fixture.projectId},
      ${fixture.userId},
      'github',
      'Issue 716 Rebuild GitHub',
      ${sql.json({ repository: 'example-org/pufu-sample' })},
      true
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
      parsed_uri,
      content_hash,
      ingest_status,
      parsed_at
    )
    VALUES (
      ${fixture.rawDocumentId},
      ${fixture.projectId},
      'github',
      'example-org/pufu-sample/issues/716',
      'example-org/pufu-sample/issues/716',
      'v1',
      'issue-716-rebuild/raw/github-issue.json',
      ${fixture.parsedUri},
      ${digest('fixture-content')},
      'parsed',
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.documents (
      id,
      project_id,
      raw_document_id,
      logical_source_id,
      doc_type,
      graph_node_id
    )
    VALUES (
      ${fixture.documentId},
      ${fixture.projectId},
      ${fixture.rawDocumentId},
      'example-org/pufu-sample/issues/716',
      'issue',
      ${fixture.documentGraphNodeId}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.actors (
      id, project_id, display_name, graph_node_id, status
    )
    VALUES (
      '20000000-0000-0000-0000-000000000706',
      ${fixture.projectId},
      'Fixture Author',
      ${fixture.actorGraphNodeId},
      'active'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.actor_aliases (
      id, project_id, actor_id, alias_type, alias_value
    )
    VALUES (
      '20000000-0000-0000-0000-000000000707',
      ${fixture.projectId},
      '20000000-0000-0000-0000-000000000706',
      'github_login',
      'fixture-author'
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function resetFixture(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM public.graph_edges WHERE project_id IN (${fixture.projectId}::uuid, ${fixture.sentinelProjectId}::uuid)`;
  await sql`DELETE FROM public.graph_nodes WHERE project_id IN (${fixture.projectId}::uuid, ${fixture.sentinelProjectId}::uuid)`;
  await sql`DELETE FROM public.email_quotes WHERE project_id = ${fixture.projectId}`;
  await sql`DELETE FROM public.documents WHERE project_id = ${fixture.projectId}`;
  await sql`DELETE FROM public.raw_documents WHERE project_id = ${fixture.projectId}`;
  await sql`DELETE FROM public.actor_aliases WHERE project_id = ${fixture.projectId}`;
  await sql`DELETE FROM public.actors WHERE project_id = ${fixture.projectId}`;
  await sql`DELETE FROM public.data_sources WHERE project_id = ${fixture.projectId}`;
  await sql`DELETE FROM public.projects WHERE id IN (${fixture.projectId}::uuid, ${fixture.sentinelProjectId}::uuid)`;
  await sql`DELETE FROM public.users WHERE id = ${fixture.userId}`;
  await sql.unsafe("LOAD 'age'");
  await sql.unsafe('SET search_path = ag_catalog, "$user", public');
  await sql.unsafe(
    `SELECT drop_graph('graph_issue_716_rebuild', true) WHERE EXISTS (
      SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'graph_issue_716_rebuild'
    )`,
  );
}

async function countGraphNodes(sql: postgres.Sql, projectId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_nodes
    WHERE project_id = ${projectId}::uuid
  `) as unknown as unknown[];
  return parseCountRow(rows[0]);
}

async function countGraphEdges(sql: postgres.Sql, projectId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.graph_edges
    WHERE project_id = ${projectId}::uuid
  `) as unknown as unknown[];
  return parseCountRow(rows[0]);
}

async function hasGraphNode(
  sql: postgres.Sql,
  projectId: string,
  nodeKey: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM public.graph_nodes
    WHERE project_id = ${projectId}::uuid
      AND node_key = ${nodeKey}
    LIMIT 1
  `) as unknown as unknown[];
  return rows.length > 0;
}

async function countEmailQuotes(sql: postgres.Sql, projectId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.email_quotes
    WHERE project_id = ${projectId}::uuid
  `) as unknown as unknown[];
  return parseCountRow(rows[0]);
}

async function readIngestionSnapshot(
  sql: postgres.Sql,
  rawDocumentId: string,
): Promise<{ ingestStatus: string; indexedAt: string | null }> {
  const rows = (await sql`
    SELECT ingest_status AS "ingestStatus", indexed_at AS "indexedAt"
    FROM public.raw_documents
    WHERE id = ${rawDocumentId}
    LIMIT 1
  `) as unknown as unknown[];
  const row = rows[0];
  if (!row || typeof row !== 'object' || row === null) {
    throw new Error('Invalid ingestion snapshot row.');
  }
  const record = row as Record<string, unknown>;
  const ingestStatus = record.ingestStatus;
  const indexedAt = record.indexedAt;
  if (typeof ingestStatus !== 'string') {
    throw new Error('Invalid ingestion snapshot ingestStatus.');
  }
  return {
    ingestStatus,
    indexedAt:
      indexedAt === null
        ? null
        : indexedAt instanceof Date
          ? indexedAt.toISOString()
          : typeof indexedAt === 'string'
            ? indexedAt
            : null,
  };
}

function parseCountRow(row: unknown): number {
  if (!row || typeof row !== 'object' || row === null) {
    throw new Error('Invalid count row.');
  }
  const count = (row as Record<string, unknown>).count;
  if (typeof count === 'number' && Number.isInteger(count)) {
    return count;
  }
  if (typeof count === 'string' && /^\d+$/.test(count)) {
    return Number(count);
  }
  throw new Error('Invalid count row.');
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
