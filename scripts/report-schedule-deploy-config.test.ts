import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const deploy = await readFile(
  new URL('../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml', import.meta.url),
  'utf8',
);

test('deploy config creates report schedule dispatcher job and five-minute scheduler', () => {
  assert.match(deploy, /report-schedule-dispatcher/);
  assert.match(
    deploy,
    /for workflow_id in curate-workflow ingest-workflow generate-report source-sync-dispatcher report-schedule-dispatcher/,
  );
  assert.match(deploy, /id: deploy-report-schedule-scheduler/);
  assert.match(deploy, /internal\/schedules\/report-schedule-dispatcher:run/);
  assert.match(deploy, /--oidc-service-account-email/);
  assert.equal((deploy.match(/id: deploy-report-schedule-scheduler/g) ?? []).length, 1);
});

test('Mastra service receives report dispatcher resource configuration without secrets', () => {
  assert.match(deploy, /REPORT_SCHEDULE_DISPATCHER_JOB_NAME=/);
  assert.match(deploy, /CLOUD_RUN_JOBS_REGION=/);
  assert.doesNotMatch(deploy, /REPORT_SCHEDULE_[A-Z_]*(TOKEN|SECRET)=/);
});
