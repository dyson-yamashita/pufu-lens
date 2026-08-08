import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const migrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0015_activitypub_protocol_spike.sql',
);
const initPath = join(import.meta.dirname, '../infra/docker/postgres/init.sql');

test('0015 creates ActivityPub Fedify KV and queue message tables', async () => {
  const migration = await readFile(migrationPath, 'utf8');

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
    readFile(migrationPath, 'utf8'),
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
