import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const deploy = await readFile(
  new URL('../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml', import.meta.url),
  'utf8',
);

test('deploy config creates one dispatcher job and one five-minute scheduler', () => {
  assert.match(deploy, /source-sync-dispatcher/);
  assert.match(
    deploy,
    /for workflow_id in curate-workflow ingest-workflow generate-report source-sync-dispatcher report-schedule-dispatcher/,
  );
  assert.match(deploy, /id: deploy-source-sync-scheduler/);
  assert.match(deploy, /--schedule "\*\/5 \* \* \* \*"/);
  assert.match(deploy, /internal\/schedules\/source-sync-dispatcher:run/);
  assert.match(deploy, /--oidc-service-account-email/);
  assert.match(
    deploy,
    /scheduler jobs update http[^\n]+--update-headers "Content-Type=application\/json"/,
  );
  assert.match(
    deploy,
    /scheduler jobs create http[^\n]+--headers "Content-Type=application\/json"/,
  );
  assert.match(deploy, /--max-retries 0/);
  assert.match(deploy, /--task-timeout 3300s/);
  assert.equal((deploy.match(/id: deploy-source-sync-scheduler/g) ?? []).length, 1);
});

test('Mastra service receives only dispatcher resource configuration', () => {
  assert.match(deploy, /SOURCE_SYNC_DISPATCHER_JOB_NAME=/);
  assert.match(deploy, /CLOUD_RUN_JOBS_REGION=/);
  assert.doesNotMatch(deploy, /SOURCE_SYNC_[A-Z_]*(TOKEN|SECRET)=/);
});
