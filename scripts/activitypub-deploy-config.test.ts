import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const deploy = await readFile(
  new URL('../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml', import.meta.url),
  'utf8',
);

test('deploy config creates ActivityPub dispatcher job and five-minute scheduler', () => {
  assert.match(deploy, /activitypub-dispatcher/);
  assert.match(
    deploy,
    /for workflow_id in curate-workflow ingest-workflow generate-report source-sync-dispatcher report-schedule-dispatcher activitypub-dispatcher/,
  );
  assert.match(deploy, /id: deploy-activitypub-dispatcher-scheduler/);
  assert.match(deploy, /internal\/schedules\/activitypub-dispatcher:run/);
  assert.match(deploy, /ACTIVITYPUB_CANONICAL_ORIGIN/);
  assert.match(deploy, /ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY/);
  assert.match(deploy, /SCHEDULER_SERVICE_ACCOUNT/);
});

test('deploy config rejects placeholder ActivityPub defaults and uses resource-scoped IAM', () => {
  assert.doesNotMatch(deploy, /https:\/\/lens\.example/);
  assert.doesNotMatch(deploy, /https:\/\/mastra\.example/);
  assert.doesNotMatch(deploy, /scheduler@example\.iam\.gserviceaccount\.com/);
  assert.match(deploy, /add-iam-policy-binding/);
  assert.match(deploy, /roles\/run\.invoker/);
  assert.match(deploy, /roles\/run\.jobsExecutorWithOverrides/);
  assert.doesNotMatch(deploy, /gcloud run (services|jobs) add-iam-policy-binding[^\n]*--project/);
  assert.match(deploy, /--oidc-token-audience "\$\$\{service_url\}"/);
  assert.match(deploy, /ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE=\$\$\{service_url\}/);
});
