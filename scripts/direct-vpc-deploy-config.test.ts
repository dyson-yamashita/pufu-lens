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

test('Cloud Build deploy config applies Direct VPC flags to migration, Mastra, and workflow jobs', () => {
  const directVpcFlags =
    /--network "\$\{_VPC_NETWORK\}"[\s\S]*?--subnet "\$\{_VPC_SUBNET\}"[\s\S]*?--vpc-egress private-ranges-only/g;
  const matches = deploy.match(directVpcFlags) ?? [];

  assert.equal(
    matches.length,
    3,
    'expected Direct VPC flags on migration job, Mastra service, and workflow jobs',
  );

  assert.match(deploy, /id: run-db-migration[\s\S]*?--network "\$\{_VPC_NETWORK\}"/);
  assert.match(deploy, /id: deploy-mastra-server[\s\S]*?--network "\$\{_VPC_NETWORK\}"/);
  assert.match(deploy, /id: deploy-workflow-jobs[\s\S]*?--network "\$\{_VPC_NETWORK\}"/);
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
