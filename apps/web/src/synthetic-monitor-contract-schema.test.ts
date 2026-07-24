import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES,
  SYNTHETIC_MONITOR_CONTRACT_VERSION,
  SYNTHETIC_MONITOR_GITHUB_EXPECTED_VERSION_PATTERN,
  SYNTHETIC_MONITOR_MAX_BODY_BYTES,
  SYNTHETIC_MONITOR_MAX_EXPECTED_RELATIONS,
  SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT,
  SYNTHETIC_MONITOR_MAX_SOURCES,
  SYNTHETIC_MONITOR_PERIOD_RUN_STATUSES,
  SYNTHETIC_MONITOR_RELATION_TYPES,
  SYNTHETIC_MONITOR_REPORT_SCHEDULE_FREQUENCIES,
  SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS,
} from './synthetic-monitor-contract.ts';

type ContractSchema = {
  readonly $defs: {
    readonly expectedRelation: {
      readonly properties: {
        readonly minCount: { readonly maximum: number };
      };
    };
    readonly githubSource: {
      readonly properties: {
        readonly expectedVersion: { readonly pattern: string };
        readonly number: { readonly maximum: number };
      };
    };
    readonly relationType: { readonly enum: readonly string[] };
    readonly request: {
      readonly properties: {
        readonly sources: { readonly maxItems: number };
      };
    };
    readonly response: {
      readonly properties: {
        readonly contractVersion: { readonly const: string };
        readonly observations: { readonly maxItems: number };
      };
    };
    readonly sourceKind: { readonly enum: readonly string[] };
    readonly stageStatus: { readonly enum: readonly string[] };
    readonly reportObservation: {
      readonly properties: {
        readonly schedule: {
          readonly properties: {
            readonly frequency: {
              readonly oneOf: readonly [
                { readonly type: 'null' },
                { readonly enum: readonly string[] },
              ];
            };
          };
        };
        readonly periodRun: {
          readonly properties: {
            readonly runStatus: {
              readonly oneOf: readonly [
                { readonly type: 'null' },
                { readonly enum: readonly string[] },
              ];
            };
          };
        };
      };
    };
  };
};

test('synthetic monitor JSON contract stays aligned with implementation constants', async () => {
  const contractPath = fileURLToPath(
    new URL('../../../docs/contracts/synthetic-monitor-v1.json', import.meta.url),
  );
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as ContractSchema;
  assert.equal(
    contract.$defs.response.properties.contractVersion.const,
    SYNTHETIC_MONITOR_CONTRACT_VERSION,
  );
  assert.equal(contract.$defs.request.properties.sources.maxItems, SYNTHETIC_MONITOR_MAX_SOURCES);
  assert.equal(
    contract.$defs.response.properties.observations.maxItems,
    SYNTHETIC_MONITOR_MAX_SOURCES,
  );
  assert.equal(
    contract.$defs.expectedRelation.properties.minCount.maximum,
    SYNTHETIC_MONITOR_MAX_RELATION_MIN_COUNT,
  );
  assert.equal(contract.$defs.githubSource.properties.number.maximum, 999_999);
  assert.deepEqual(
    [...contract.$defs.relationType.enum].sort(),
    [...SYNTHETIC_MONITOR_RELATION_TYPES].sort(),
  );
  assert.deepEqual(contract.$defs.sourceKind.enum, ['drive', 'github', 'gmail', 'web']);
  assert.deepEqual(contract.$defs.stageStatus.enum, ['failed', 'not_found', 'ok', 'pending']);
  assert.equal(SYNTHETIC_MONITOR_MAX_BODY_BYTES, 64 * 1024);
  assert.equal(SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(SYNTHETIC_MONITOR_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(SYNTHETIC_MONITOR_MAX_EXPECTED_RELATIONS, 10);
  const validGitHubVersion =
    '2026-07-01T00:00:00.000Z:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const schemaPattern = new RegExp(contract.$defs.githubSource.properties.expectedVersion.pattern);
  assert.equal(schemaPattern.source, SYNTHETIC_MONITOR_GITHUB_EXPECTED_VERSION_PATTERN.source);
  assert.equal(schemaPattern.test(validGitHubVersion), true);
  assert.equal(SYNTHETIC_MONITOR_GITHUB_EXPECTED_VERSION_PATTERN.test(validGitHubVersion), true);
  assert.equal(schemaPattern.test('not-a-version'), false);
  assert.equal(schemaPattern.test('2026-07-01:not-a-sha'), false);
  assert.deepEqual(
    [
      ...contract.$defs.reportObservation.properties.schedule.properties.frequency.oneOf[1].enum,
    ].sort(),
    [...SYNTHETIC_MONITOR_REPORT_SCHEDULE_FREQUENCIES].sort(),
  );
  assert.deepEqual(
    [
      ...contract.$defs.reportObservation.properties.periodRun.properties.runStatus.oneOf[1].enum,
    ].sort(),
    [...SYNTHETIC_MONITOR_PERIOD_RUN_STATUSES].sort(),
  );
});
