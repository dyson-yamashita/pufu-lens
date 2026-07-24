import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import {
  BUILT_IN_PARSER_VERSION,
  LEGACY_BUILT_IN_PARSER_VERSION,
} from '../../packages/ingestion/dist/index.js';
import {
  countStaleParserRawDocuments,
  listStaleParserRawDocuments,
  resetStaleParserRawDocuments,
} from './ingest-workflow-reprocess.ts';

const databaseUrl = process.env.DATABASE_URL?.trim();

const fixture = {
  approvedByUserId: '10000000-0000-0000-0000-000000000658',
  builtInProfileId: '10000000-0000-0000-0000-000000000660',
  builtInV1VersionId: '10000000-0000-0000-0000-000000000661',
  builtInV2VersionId: '10000000-0000-0000-0000-000000000662',
  customProfileId: '10000000-0000-0000-0000-000000000663',
  customV1VersionId: '10000000-0000-0000-0000-000000000664',
  dataSourceId: '10000000-0000-0000-0000-000000000665',
  projectId: '10000000-0000-0000-0000-000000000666',
  queueId: '10000000-0000-0000-0000-000000000667',
  rawDocumentId: '10000000-0000-0000-0000-000000000668',
  userId: '10000000-0000-0000-0000-000000000658',
} as const;

test('stale parser queries compare queue raws only against the built-in active profile', {
  skip: !databaseUrl,
}, async () => {
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await resetFixture(sql);
    await seedStaleReprocessFixture(sql);

    const remaining = await countStaleParserRawDocuments({
      projectId: fixture.projectId,
      sourceType: 'github',
      sql,
    });
    const selected = await listStaleParserRawDocuments({
      limit: 10,
      projectId: fixture.projectId,
      sourceType: 'github',
      sql,
    });

    assert.equal(remaining, 1);
    assert.deepEqual(selected, [
      {
        queueId: fixture.queueId,
        rawDocumentId: fixture.rawDocumentId,
        sourceId: 'github-issue-stale-649',
      },
    ]);

    const reset = await resetStaleParserRawDocuments({
      limit: 1,
      projectId: fixture.projectId,
      sourceType: 'github',
      sql,
    });
    assert.equal(reset.queueItems, 1);
    assert.equal(reset.rawDocuments, 1);
    assert.equal(reset.remaining, 0);
    assert.deepEqual(reset.selected, selected);
  } finally {
    try {
      await resetFixture(sql);
    } finally {
      await sql.end();
    }
  }
});

async function seedStaleReprocessFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO public.users (id, email, name, role)
    VALUES (${fixture.userId}, 'issue-649-reprocess@example.test', 'Issue 649 Reprocess', 'admin')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixture.projectId},
      'issue-649-reprocess-stale',
      'Issue 649 Reprocess Stale',
      'graph_issue_649_reprocess_stale',
      'issue-649-reprocess-stale',
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
      'Issue 649 Reprocess GitHub',
      ${sql.json({ repository: 'example-org/pufu-sample' })},
      true
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.parser_profiles (
      id, project_id, data_source_id, source_type, name, active_version_id, metadata
    )
    VALUES
      (
        ${fixture.builtInProfileId},
        ${fixture.projectId},
        ${fixture.dataSourceId},
        'github',
        'Built-in github parser',
        ${fixture.builtInV2VersionId},
        ${sql.json({ managedBy: 'fixture' })}
      ),
      (
        ${fixture.customProfileId},
        ${fixture.projectId},
        ${fixture.dataSourceId},
        'github',
        'Custom github parser',
        ${fixture.customV1VersionId},
        ${sql.json({ managedBy: 'fixture-custom' })}
      )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.parser_versions (
      id,
      parser_profile_id,
      version,
      schema_version,
      artifact_hash,
      contract,
      status,
      approved_by_user_id,
      approved_at
    )
    VALUES
      (
        ${fixture.builtInV1VersionId},
        ${fixture.builtInProfileId},
        ${LEGACY_BUILT_IN_PARSER_VERSION},
        1,
        'issue-649-built-in-v1-hash',
        ${sql.json({ requiredPaths: ['kind'] })},
        'approved',
        ${fixture.approvedByUserId},
        now()
      ),
      (
        ${fixture.builtInV2VersionId},
        ${fixture.builtInProfileId},
        ${BUILT_IN_PARSER_VERSION},
        1,
        'issue-649-built-in-v2-hash',
        ${sql.json({ requiredPaths: ['kind'] })},
        'approved',
        ${fixture.approvedByUserId},
        now()
      ),
      (
        ${fixture.customV1VersionId},
        ${fixture.customProfileId},
        ${LEGACY_BUILT_IN_PARSER_VERSION},
        1,
        'issue-649-custom-v1-hash',
        ${sql.json({ requiredPaths: ['kind'] })},
        'approved',
        ${fixture.approvedByUserId},
        now()
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
      parser_profile_id,
      parser_version_id,
      parsed_uri
    )
    VALUES (
      ${fixture.rawDocumentId},
      ${fixture.projectId},
      'github',
      'github-issue-stale-649',
      'example-org/pufu-sample/issues/stale-649',
      'github-issue-stale-649-v1',
      'raw/github-issue-stale-649.json',
      'issue-649-stale-hash',
      'indexed',
      ${fixture.builtInProfileId},
      ${fixture.builtInV1VersionId},
      'sample-a/parsed/github/github-issue-stale-649.json'
    )
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO public.ingestion_queue (
      id,
      project_id,
      data_source_id,
      raw_document_id,
      target_id,
      status,
      parser_profile_id,
      parser_version_id
    )
    VALUES (
      ${fixture.queueId},
      ${fixture.projectId},
      ${fixture.dataSourceId},
      ${fixture.rawDocumentId},
      'github-issue-stale-649',
      'indexed',
      ${fixture.builtInProfileId},
      ${fixture.builtInV1VersionId}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function resetFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    DELETE FROM public.ingestion_queue
    WHERE project_id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.raw_documents
    WHERE project_id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.parser_versions
    WHERE parser_profile_id IN (${fixture.builtInProfileId}, ${fixture.customProfileId})
  `;
  await sql`
    DELETE FROM public.parser_profiles
    WHERE project_id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.data_sources
    WHERE project_id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.projects
    WHERE id = ${fixture.projectId}
  `;
  await sql`
    DELETE FROM public.users
    WHERE id = ${fixture.userId}
  `;
}
