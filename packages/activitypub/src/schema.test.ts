import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import {
  parseActivityPubActivityRow,
  parseActivityPubActorEncryptedKeyRow,
  parseActivityPubActorRow,
  parseActivityPubFollowRow,
  parseActivityPubInstanceConfigRow,
  parseActivityPubProjectScopeRow,
  parseActivityPubQueueMessageRow,
  parseFederatedReportRow,
  parsePublicReportArticleRow,
} from './schema.ts';

const validActor = {
  id: 'a0000000-0000-0000-0000-000000000001',
  project_id: '10000000-0000-0000-0000-000000000001',
  kind: 'project',
  preferred_username: 'sample-project',
  display_name: 'Sample Project',
  icon_url: null,
  additional_prompt: null,
  enabled: true,
  public_key_pem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

const validActivity = {
  id: 'b0000000-0000-0000-0000-000000000001',
  activity_uri: 'https://lens.test/activitypub/activities/create/1',
  object_uri: null,
  activity_type: 'Create',
  actor_uri: 'https://lens.test/activitypub/actors/all',
  local_actor_id: validActor.id,
  direction: 'outbound',
  payload_json: {},
  processing_status: 'pending',
  available_at: validActor.created_at,
  attempt_count: 0,
  worker_token: null,
  lease_expires_at: null,
  occurred_at: validActor.created_at,
  processed_at: null,
};

const validQueueMessage = {
  id: 'q0000000-0000-0000-0000-000000000001',
  dedupe_key: 'activity|inbox',
  queue_kind: 'outbox',
  ordering_key: 'https://lens.test/activitypub/reports/1',
  recipient_origin: 'https://remote.example',
  message_json: {},
  status: 'pending',
  available_at: validActor.created_at,
  attempt_count: 0,
  worker_token: null,
  lease_expires_at: null,
  last_error_code: null,
  last_http_status: null,
  created_at: validActor.created_at,
  started_at: null,
  completed_at: null,
  updated_at: validActor.updated_at,
};

const validFederatedReport = {
  id: 'r0000000-0000-0000-0000-000000000001',
  project_id: validActor.project_id,
  source_follow_id: 'f0000000-0000-0000-0000-000000000001',
  remote_object_uri: 'https://remote.example/objects/1',
  remote_activity_uri: 'https://remote.example/activities/1',
  remote_actor_uri: 'https://remote.example/users/alice',
  object_type: 'article',
  title: 'Title',
  summary_html_sanitized: '',
  original_url: 'https://remote.example/reports/1',
  published_at: null,
  remote_updated_at: null,
  received_at: validActor.created_at,
};

const validPublicReportArticle = {
  report_id: '30000000-0000-0000-0000-000000000001',
  project_id: validActor.project_id,
  project_slug: 'sample-project',
  preferred_username: 'sample-project',
  title: 'Quarterly Update',
  summary: 'Summary',
  published_at: validActor.created_at,
};

test('schema parsers accept valid rows', () => {
  assert.deepEqual(
    parseActivityPubInstanceConfigRow({
      id: 1,
      object_representation: 'article',
      representation_locked_at: null,
      created_at: validActor.created_at,
      updated_at: validActor.updated_at,
    }).objectRepresentation,
    'article',
  );

  assert.equal(parseActivityPubActorRow(validActor).preferredUsername, 'sample-project');
  assert.equal(
    parseActivityPubProjectScopeRow({
      id: validActor.project_id,
      slug: 'sample-project',
      name: 'Sample Project',
      visibility: 'public',
    }).visibility,
    'public',
  );
  assert.ok(
    parseActivityPubActorEncryptedKeyRow({
      encrypted_private_key: { version: 1 },
      public_key_pem: validActor.public_key_pem,
    }),
  );
  assert.equal(
    parseActivityPubFollowRow({
      id: 'f0000000-0000-0000-0000-000000000001',
      direction: 'outbound',
      local_actor_id: validActor.id,
      remote_actor_uri: 'https://remote.example/users/alice',
      remote_inbox_uri: 'https://remote.example/users/alice/inbox',
      remote_shared_inbox_uri: null,
      follow_activity_uri: 'https://remote.example/activities/1',
      status: 'accepted',
      created_at: validActor.created_at,
      accepted_at: null,
      undone_at: null,
      updated_at: validActor.updated_at,
    }).status,
    'accepted',
  );
  assert.equal(parseActivityPubActivityRow(validActivity).direction, 'outbound');
  assert.equal(parseActivityPubActivityRow(validActivity).attemptCount, 0);
  assert.equal(parseActivityPubQueueMessageRow(validQueueMessage).queueKind, 'outbox');
  assert.equal(parseFederatedReportRow(validFederatedReport).objectType, 'article');
  assert.equal(parsePublicReportArticleRow(validPublicReportArticle).title, 'Quarterly Update');
});

test('schema parsers reject malformed rows', () => {
  assert.throws(() => parseActivityPubInstanceConfigRow({ id: 2 }), /id/);
  assert.throws(() => parseActivityPubActorRow({ ...validActor, kind: 'service' }), /kind/);
  assert.throws(
    () =>
      parseActivityPubProjectScopeRow({
        id: validActor.project_id,
        slug: 'sample-project',
        name: 'Sample Project',
        visibility: 'hidden',
      }),
    /visibility/,
  );
  assert.throws(
    () =>
      parseActivityPubActorEncryptedKeyRow({
        encrypted_private_key: 'x',
        public_key_pem: validActor.public_key_pem,
      }),
    /encrypted_private_key/,
  );
  assert.throws(
    () => parseActivityPubActivityRow({ ...validActivity, payload_json: [] }),
    /payload_json/,
  );
  assert.throws(
    () => parseActivityPubQueueMessageRow({ ...validQueueMessage, status: 'done' }),
    /status/,
  );
  assert.throws(
    () => parseFederatedReportRow({ ...validFederatedReport, object_type: 'video' }),
    /object_type/,
  );
  assert.throws(
    () => parsePublicReportArticleRow({ ...validPublicReportArticle, report_id: 1 }),
    /report_id/,
  );
});

test('parseActivityPubQueueMessageRow accepts allowlisted last_error_code values', () => {
  assert.equal(
    parseActivityPubQueueMessageRow({
      ...validQueueMessage,
      last_error_code: DELIVERY_ERROR_CODES.http5xx,
    }).lastErrorCode,
    DELIVERY_ERROR_CODES.http5xx,
  );
  assert.equal(parseActivityPubQueueMessageRow(validQueueMessage).lastErrorCode, null);
});

test('parseActivityPubQueueMessageRow rejects unknown last_error_code values', () => {
  assert.throws(
    () =>
      parseActivityPubQueueMessageRow({
        ...validQueueMessage,
        last_error_code: 'activitypub_delivery_failed',
      }),
    /last_error_code/,
  );
});
