import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const migration0015Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0015_activitypub_protocol_spike.sql',
);
const migration0016Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0016_activitypub_actor_endpoints.sql',
);
const migration0017Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0017_activitypub_follow_management.sql',
);
const migration0018Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0018_activitypub_follow_indexes.sql',
);
const migration0019Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0019_activitypub_follow_constraint_validation.sql',
);
const migration0020Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0020_activitypub_report_publication_outbox.sql',
);
const migration0021Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0021_activitypub_validate_step4_constraints.sql',
);
const migration0022Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0022_activitypub_inbound_reports.sql',
);
const migration0023Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0023_activitypub_validate_inbound_report_constraints.sql',
);
const initPath = join(import.meta.dirname, '../infra/docker/postgres/init.sql');

test('0015 creates ActivityPub Fedify KV and queue message tables', async () => {
  const migration = await readFile(migration0015Path, 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.activitypub_fedify_kv/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.activitypub_queue_messages/);
  assert.match(migration, /dedupe_key/);
  assert.match(migration, /UNIQUE \(dedupe_key\)/);
  assert.match(migration, /queue_kind/);
  assert.match(migration, /ordering_key/);
  assert.match(migration, /recipient_origin/);
  assert.match(migration, /message_json/);
  assert.match(migration, /status/);
  assert.match(migration, /worker_token/);
  assert.match(migration, /lease_expires_at/);
  assert.match(migration, /activitypub_queue_messages_lease_pair_check/);
  assert.match(migration, /queue_kind = 'outbox' AND ordering_key IS NOT NULL/);
  assert.match(migration, /queue_kind = 'outbox' AND recipient_origin IS NOT NULL/);
});

test('0015 and fresh schema share ActivityPub queue constraints and migration version', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0015Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'activitypub_fedify_kv',
    'activitypub_queue_messages',
    'activitypub_queue_messages_dedupe_key_key',
    'activitypub_queue_messages_lease_pair_check',
    'activitypub_queue_messages_outbox_ordering_check',
    'activitypub_queue_messages_outbox_recipient_check',
  ]) {
    assert.ok(migration.includes(name), `${name} is missing from migration`);
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }

  assert.match(init, /'0015_activitypub_protocol_spike'/);
});

test('0016 creates ActivityPub Step 2 actor, follow, activity, and federated report tables', async () => {
  const migration = await readFile(migration0016Path, 'utf8');

  for (const table of [
    'activitypub_instance_config',
    'activitypub_actors',
    'activitypub_follows',
    'activitypub_activities',
    'federated_reports',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
  }

  assert.match(migration, /activitypub_instance_config_singleton_id_check/);
  assert.match(migration, /object_representation IN \('article', 'note'\)/);
  assert.match(migration, /INSERT INTO public\.activitypub_instance_config/);
  assert.match(migration, /VALUES \(1, 'article'\)/);
  assert.match(migration, /activitypub_guard_instance_config/);
  assert.match(migration, /activitypub_instance_config_guard/);
  assert.match(migration, /cannot be deleted/);
  assert.match(migration, /cannot change after lock/);
  assert.match(migration, /cannot be unlocked/);

  assert.match(migration, /activitypub_actors_preferred_username_key/);
  assert.match(migration, /activitypub_actors_aggregate_unique_idx/);
  assert.match(migration, /activitypub_actors_project_id_key/);
  assert.match(migration, /activitypub_actors_kind_project_consistency_check/);
  assert.match(migration, /preferred_username = 'all'/);
  assert.match(migration, /preferred_username <> 'all'/);
  assert.match(migration, /activitypub_actors_preferred_username_syntax_check/);

  assert.match(migration, /activitypub_follows_direction_local_remote_key/);
  assert.match(migration, /direction IN \('inbound', 'outbound'\)/);
  assert.match(migration, /status IN \('pending', 'accepted', 'rejected', 'undone'\)/);

  assert.match(migration, /activitypub_activities_activity_uri_key/);
  assert.match(migration, /activitypub_activities_payload_json_object_check/);
  assert.match(migration, /activitypub_activities_lease_pair_check/);
  assert.match(migration, /activitypub_activities_outbound_local_actor_check/);
  assert.match(migration, /activitypub_lock_representation_on_first_outbound/);
  assert.match(migration, /activitypub_activities_first_outbound_lock/);

  assert.match(migration, /activitypub_queue_messages_message_json_object_check/);

  assert.match(migration, /federated_reports_object_type_check/);
  assert.match(migration, /federated_reports_project_remote_object_key/);
});

test('0016 and fresh schema share Step 2 table definitions and migration version', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0016Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'activitypub_instance_config',
    'activitypub_actors',
    'activitypub_actors_preferred_username_key',
    'activitypub_actors_aggregate_unique_idx',
    'activitypub_actors_project_id_key',
    'activitypub_actors_kind_project_consistency_check',
    'activitypub_follows',
    'activitypub_follows_direction_local_remote_key',
    'activitypub_activities',
    'activitypub_activities_activity_uri_key',
    'activitypub_activities_first_outbound_lock',
    'activitypub_activities_outbound_local_actor_check',
    'activitypub_queue_messages_message_json_object_check',
    'federated_reports',
    'federated_reports_project_remote_object_key',
    'activitypub_guard_instance_config',
  ]) {
    assert.ok(migration.includes(name), `${name} is missing from migration`);
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }

  assert.match(init, /'0016_activitypub_actor_endpoints'/);
});

test('0016 and fresh schema lock representation trigger avoids COUNT scans and uses guarded singleton update', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0016Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const [label, sql] of [
    ['migration', migration],
    ['fresh schema', init],
  ] as const) {
    const triggerBody = extractTriggerFunctionBody(
      sql,
      'activitypub_lock_representation_on_first_outbound',
    );
    assert.ok(triggerBody, `${label} trigger function body is missing`);
    assert.equal(triggerBody.includes('COUNT(*)'), false, `${label} must not use COUNT(*)`);
    assert.equal(
      triggerBody.includes('existing_outbound_count'),
      false,
      `${label} must not use existing_outbound_count`,
    );
    assert.match(
      triggerBody,
      /UPDATE public\.activitypub_instance_config[\s\S]*representation_locked_at IS NULL/,
      `${label} must guard singleton update with representation_locked_at IS NULL`,
    );
    assert.match(
      triggerBody,
      /activitypub_instance_config singleton is missing/,
      `${label} must validate missing singleton row`,
    );
  }
});

test('0017 adds follow timestamp checks with NOT VALID only', async () => {
  const migration = await readFile(migration0017Path, 'utf8');

  assert.equal(migration.includes('CREATE INDEX'), false);
  assert.match(
    migration,
    /ADD CONSTRAINT activitypub_follows_accepted_timestamp_check[\s\S]*CHECK \([\s\S]*status = 'accepted' AND accepted_at IS NOT NULL[\s\S]*status <> 'accepted' AND accepted_at IS NULL[\s\S]*\) NOT VALID;/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT activitypub_follows_undone_timestamp_check[\s\S]*CHECK \([\s\S]*status = 'undone' AND undone_at IS NOT NULL[\s\S]*status <> 'undone' AND undone_at IS NULL[\s\S]*\) NOT VALID;/,
  );
  assert.equal(migration.includes('VALIDATE CONSTRAINT'), false);
  assert.equal(
    /INSERT INTO public\.schema_migrations/.test(migration),
    false,
    'migration must not insert schema_migrations; runner owns version recording',
  );
});

test('0019 validates follow timestamp checks in a separate transactional migration', async () => {
  const migration = await readFile(migration0019Path, 'utf8');

  assert.match(migration, /VALIDATE CONSTRAINT activitypub_follows_accepted_timestamp_check;/);
  assert.match(migration, /VALIDATE CONSTRAINT activitypub_follows_undone_timestamp_check;/);
  assert.equal(migration.includes('ADD CONSTRAINT'), false);
  assert.equal(migration.includes('DROP CONSTRAINT'), false);
  assert.equal(
    /INSERT INTO public\.schema_migrations/.test(migration),
    false,
    'migration must not insert schema_migrations; runner owns version recording',
  );
});

test('0018 adds concurrent follow indexes outside transactions', async () => {
  const migration = await readFile(migration0018Path, 'utf8');

  assert.match(migration, /^-- pufu-lens: no-transaction/);
  assert.equal(
    migration.split('\n').filter((line) => line.trim() === '-- pufu-lens: statement-break').length,
    3,
  );
  assert.match(
    migration,
    /DROP INDEX CONCURRENTLY IF EXISTS public\.activitypub_follows_accepted_collection_idx;/,
  );
  assert.match(migration, /-- pufu-lens: statement-break/);
  assert.match(
    migration,
    /CREATE INDEX CONCURRENTLY activitypub_follows_accepted_collection_idx[\s\S]*ON public\.activitypub_follows \(local_actor_id, direction, created_at, id\)[\s\S]*WHERE status = 'accepted';/,
  );
  assert.equal(migration.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS'), false);
  assert.match(
    migration,
    /DROP INDEX CONCURRENTLY IF EXISTS public\.activitypub_follows_outbound_project_list_idx;/,
  );
  assert.match(
    migration,
    /CREATE INDEX CONCURRENTLY activitypub_follows_outbound_project_list_idx[\s\S]*ON public\.activitypub_follows \(local_actor_id, created_at, id\)[\s\S]*WHERE direction = 'outbound';/,
  );
  assert.equal(
    /INSERT INTO public\.schema_migrations/.test(migration),
    false,
    'migration must not insert schema_migrations; runner owns version recording',
  );
});

test('0017, 0018, 0019, and fresh schema share follow constraints, indexes, and migration versions', async () => {
  const [migration0017, migration0018, migration0019, init] = await Promise.all([
    readFile(migration0017Path, 'utf8'),
    readFile(migration0018Path, 'utf8'),
    readFile(migration0019Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'activitypub_follows_accepted_timestamp_check',
    'activitypub_follows_undone_timestamp_check',
    'activitypub_follows_accepted_collection_idx',
    'activitypub_follows_outbound_project_list_idx',
  ]) {
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }

  assert.match(
    init,
    /CONSTRAINT activitypub_follows_accepted_timestamp_check[\s\S]*CHECK \([\s\S]*status = 'accepted' AND accepted_at IS NOT NULL[\s\S]*status = 'undone' AND undone_at IS NOT NULL[\s\S]*status IN \('pending', 'rejected'\) AND accepted_at IS NULL AND undone_at IS NULL[\s\S]*\)/,
  );
  assert.match(
    init,
    /CONSTRAINT activitypub_follows_undone_timestamp_check[\s\S]*CHECK \([\s\S]*status = 'undone' AND undone_at IS NOT NULL[\s\S]*status <> 'undone' AND undone_at IS NULL[\s\S]*\)/,
  );
  assert.match(
    init,
    /CREATE INDEX IF NOT EXISTS activitypub_follows_accepted_collection_idx[\s\S]*WHERE status = 'accepted'/,
  );
  assert.match(
    init,
    /CREATE INDEX IF NOT EXISTS activitypub_follows_outbound_project_list_idx[\s\S]*WHERE direction = 'outbound'/,
  );

  assert.equal(migration0017.includes('DROP CONSTRAINT'), false);
  assert.equal(migration0018.includes('DROP CONSTRAINT'), false);
  assert.equal(migration0019.includes('DROP CONSTRAINT'), false);
  assert.match(init, /'0017_activitypub_follow_management'/);
  assert.match(init, /'0018_activitypub_follow_indexes'/);
  assert.match(init, /'0019_activitypub_follow_constraint_validation'/);
});

test('0020 adds report publication outbox columns, dispatcher lease fields, and follow audience timestamps', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0020Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'activitypub_published_at',
    'activitypub_public_summary',
    'activitypub_activities_attempt_count_check',
    'activitypub_queue_messages_last_error_code_check',
    'activitypub_activities_last_error_code_check',
    'attempt_lease_started_at',
    'activitypub_activities_outbound_due_idx',
    'activitypub_activities_outbound_running_lease_idx',
    'activitypub_queue_messages_running_lease_idx',
    'activitypub_queue_messages_outbox_claim_idx',
  ]) {
    assert.ok(migration.includes(name), `${name} is missing from migration`);
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }

  assert.match(migration, /DROP CONSTRAINT IF EXISTS activitypub_follows_accepted_timestamp_check/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS activitypub_activities_attempt_count_check/);
  assert.match(init, /'0020_activitypub_report_publication_outbox'/);
});

test('0021 validates Step 4 NOT VALID constraints', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0021Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  assert.match(migration, /VALIDATE CONSTRAINT activitypub_activities_attempt_count_check/);
  assert.match(migration, /VALIDATE CONSTRAINT activitypub_follows_accepted_timestamp_check/);
  assert.match(migration, /VALIDATE CONSTRAINT activitypub_queue_messages_last_error_code_check/);
  assert.match(migration, /VALIDATE CONSTRAINT activitypub_activities_last_error_code_check/);
  assert.match(init, /'0021_activitypub_validate_step4_constraints'/);
});

test('0020, 0021, and fresh schema share last_error_code allowlist constraints', async () => {
  const [migration0020, migration0021, init] = await Promise.all([
    readFile(migration0020Path, 'utf8'),
    readFile(migration0021Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'activitypub_queue_messages_last_error_code_check',
    'activitypub_activities_last_error_code_check',
  ]) {
    assert.match(migration0020, new RegExp(`DROP CONSTRAINT IF EXISTS ${name}`));
    assert.match(migration0020, new RegExp(`ADD CONSTRAINT ${name}[\\s\\S]*NOT VALID`));
    assert.match(migration0021, new RegExp(`VALIDATE CONSTRAINT ${name}`));
    assert.match(init, new RegExp(`CONSTRAINT ${name}`));
  }

  for (const code of [
    'delivery_timeout',
    'network_error',
    'http_408',
    'http_429',
    'http_5xx',
    'inbox_gone',
    'http_4xx',
    'unknown_delivery_error',
    'lease_lost',
    'activitypub_predecessor_failure',
    'activitypub_materialization_private',
    'activitypub_materialization_disabled',
    'activitypub_materialization_representation',
    'activitypub_materialization_retry_exhausted',
  ]) {
    assert.match(migration0020, new RegExp(`'${code}'`));
    assert.match(init, new RegExp(`'${code}'`));
  }
});

test('0020 normalizes legacy activitypub_delivery_failed before last_error_code CHECK constraints', async () => {
  const migration = await readFile(migration0020Path, 'utf8');

  assert.match(
    migration,
    /UPDATE public\.activitypub_queue_messages[\s\S]*SET last_error_code = 'unknown_delivery_error'[\s\S]*WHERE last_error_code = 'activitypub_delivery_failed'/,
  );

  const backfillIndex = migration.indexOf("WHERE last_error_code = 'activitypub_delivery_failed'");
  const queueCheckIndex = migration.indexOf(
    'ADD CONSTRAINT activitypub_queue_messages_last_error_code_check',
  );
  const activitiesCheckIndex = migration.indexOf(
    'ADD CONSTRAINT activitypub_activities_last_error_code_check',
  );
  assert.ok(backfillIndex >= 0);
  assert.ok(queueCheckIndex > backfillIndex);
  assert.ok(activitiesCheckIndex > backfillIndex);

  const queueAllowlist = migration.match(
    /ADD CONSTRAINT activitypub_queue_messages_last_error_code_check[\s\S]*?\) NOT VALID;/,
  )?.[0];
  const activitiesAllowlist = migration.match(
    /ADD CONSTRAINT activitypub_activities_last_error_code_check[\s\S]*?\) NOT VALID;/,
  )?.[0];
  assert.ok(queueAllowlist);
  assert.ok(activitiesAllowlist);
  assert.equal(queueAllowlist.includes("'activitypub_delivery_failed'"), false);
  assert.equal(activitiesAllowlist.includes("'activitypub_delivery_failed'"), false);
});

test('0022 inbound federated report constraints allow query strings and reject fragments', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0022Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);
  for (const sql of [migration, init]) {
    assert.match(sql, /\^https:\/\/\[\^\[:space:\]#\]\+\$/);
    assert.doesNotMatch(sql, /#\?/);
    assert.match(sql, /federated_reports_validate_follow/);
    assert.match(
      sql,
      /BEFORE INSERT OR UPDATE OF project_id, source_follow_id, remote_actor_uri ON public\.federated_reports/,
    );
    assert.match(sql, /TG_OP = 'UPDATE'/);
    assert.match(sql, /OLD\.project_id IS DISTINCT FROM NEW\.project_id/);
    assert.match(sql, /OLD\.source_follow_id IS DISTINCT FROM NEW\.source_follow_id/);
    assert.match(sql, /OLD\.remote_actor_uri IS DISTINCT FROM NEW\.remote_actor_uri/);
  }
});

test('0023 validates inbound federated report constraints', async () => {
  const migration = await readFile(migration0023Path, 'utf8');
  assert.match(migration, /VALIDATE CONSTRAINT federated_reports_remote_object_uri_https_check/);
  assert.match(migration, /VALIDATE CONSTRAINT federated_reports_original_url_https_check/);
});

const migration0025Path = join(
  import.meta.dirname,
  '../infra/db/migrations/0025_activitypub_actor_profiles.sql',
);

test('0025 adds ActivityPub actor profile columns with fresh schema parity', async () => {
  const [migration, init] = await Promise.all([
    readFile(migration0025Path, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'icon_url',
    'additional_prompt',
    'activitypub_actors_icon_url_length_check',
    'activitypub_actors_additional_prompt_length_check',
  ]) {
    assert.ok(migration.includes(name), `${name} is missing from migration`);
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }

  assert.match(init, /'0025_activitypub_actor_profiles'/);
});

function extractTriggerFunctionBody(sql: string, functionName: string): string | undefined {
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${functionName}\\(\\)[\\s\\S]*?\\$\\$;`,
  );
  const match = sql.match(pattern);
  return match?.[0];
}
