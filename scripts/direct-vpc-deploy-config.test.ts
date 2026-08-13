import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const deploy = await readFile(
  new URL('../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml', import.meta.url),
  'utf8',
);
const productionAppHosting = await readFile(
  new URL('../apps/web/apphosting.yaml', import.meta.url),
  'utf8',
);
const exampleAppHosting = await readFile(
  new URL('../deploy/examples/gcp-cloud-build/apphosting.example.yaml', import.meta.url),
  'utf8',
);

test('Cloud Build deploy config defines and requires Direct VPC substitutions', () => {
  assert.match(deploy, /_VPC_NETWORK: default/);
  assert.match(deploy, /_VPC_SUBNET: pufu-lens-serverless/);
  assert.match(deploy, /"_VPC_NETWORK=\$\{_VPC_NETWORK\}"/);
  assert.match(deploy, /"_VPC_SUBNET=\$\{_VPC_SUBNET\}"/);
  assert.doesNotMatch(deploy, /_VPC_CONNECTOR/);
  assert.doesNotMatch(deploy, /--vpc-connector/);
  assert.match(deploy, /_FIREBASE_TOOLS_VERSION: 15\.25\.1/);
});

function extractStepScript(deployYaml: string, stepId: string): string {
  const stepStart = deployYaml.indexOf(`- id: ${stepId}`);
  assert.notEqual(stepStart, -1, `missing Cloud Build step ${stepId}`);
  const nextStepStart = deployYaml.indexOf('\n  - id: ', stepStart + 1);
  const stepBlock =
    nextStepStart === -1 ? deployYaml.slice(stepStart) : deployYaml.slice(stepStart, nextStepStart);
  const scriptMatch = stepBlock.match(/args:\s*\n\s*- -c\s*\n\s*- \|\s*\n([\s\S]*)/);
  assert.ok(scriptMatch?.[1], `missing script body for Cloud Build step ${stepId}`);
  return scriptMatch[1];
}

function extractJobArgsBlock(script: string): string {
  const match = script.match(/job_args=\(\s*[\s\S]*?\n\s*\)/);
  assert.ok(match, 'expected job_args array in step script');
  return match[0];
}

test('Cloud Build job steps keep Direct VPC flags in shared job_args without --clear-vpc-connector', () => {
  for (const stepId of ['run-db-migration', 'deploy-workflow-jobs'] as const) {
    const jobArgs = extractJobArgsBlock(extractStepScript(deploy, stepId));
    assert.match(jobArgs, /--network "\$\{_VPC_NETWORK\}"/);
    assert.match(jobArgs, /--subnet "\$\{_VPC_SUBNET\}"/);
    assert.match(jobArgs, /--vpc-egress private-ranges-only/);
    assert.doesNotMatch(jobArgs, /--clear-vpc-connector/);
  }
});

test('Cloud Build job steps pass --clear-vpc-connector only to update, not create', () => {
  const migrationScript = extractStepScript(deploy, 'run-db-migration');
  assert.match(
    migrationScript,
    /gcloud run jobs update "\$\{job_args\[@\]\}" --clear-vpc-connector/,
  );
  assert.match(migrationScript, /gcloud run jobs create "\$\{job_args\[@\]\}"/);
  assert.doesNotMatch(
    migrationScript,
    /gcloud run jobs create "\$\{job_args\[@\]\}" --clear-vpc-connector/,
  );

  const workflowScript = extractStepScript(deploy, 'deploy-workflow-jobs');
  assert.match(
    workflowScript,
    /gcloud run jobs update "\$\$\{job_args\[@\]\}" --clear-vpc-connector/,
  );
  assert.match(workflowScript, /gcloud run jobs create "\$\$\{job_args\[@\]\}"/);
  assert.doesNotMatch(
    workflowScript,
    /gcloud run jobs create "\$\$\{job_args\[@\]\}" --clear-vpc-connector/,
  );
});

test('Cloud Build Mastra deploy retains --clear-vpc-connector', () => {
  const mastraScript = extractStepScript(deploy, 'deploy-mastra-server');
  assert.match(mastraScript, /--clear-vpc-connector/);
});

test('production App Hosting uses Direct VPC networkInterfaces with private egress only', () => {
  assert.match(productionAppHosting, /egress: PRIVATE_RANGES_ONLY/);
  assert.match(productionAppHosting, /networkInterfaces:/);
  assert.match(productionAppHosting, /network: default/);
  assert.match(productionAppHosting, /subnetwork: pufu-lens-serverless/);
  assert.doesNotMatch(productionAppHosting, /connector:/);
});

test('OSS App Hosting example documents Direct VPC placeholders without connector settings', () => {
  assert.match(exampleAppHosting, /egress: PRIVATE_RANGES_ONLY/);
  assert.match(exampleAppHosting, /networkInterfaces:/);
  assert.match(exampleAppHosting, /network: '<vpc-network-name>'/);
  assert.match(exampleAppHosting, /subnetwork: '<direct-vpc-subnet-name>'/);
  assert.doesNotMatch(exampleAppHosting, /connector:/);
});
