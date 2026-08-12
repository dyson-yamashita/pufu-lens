import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const observabilityRoot = fileURLToPath(
  new URL('../deploy/examples/gcp-cloud-build/activitypub-observability/', import.meta.url),
);
const applyScript = join(observabilityRoot, 'apply.sh');
const fakeGcloudFixture = fileURLToPath(
  new URL('./fixtures/fake-gcloud-apply-test.sh', import.meta.url),
);

const REQUIRED_METRICS = [
  'activitypub_request_count',
  'activitypub_queue_depth_pending',
  'activitypub_queue_depth_total',
  'activitypub_dispatcher_duration_ms',
  'activitypub_total_business_table_bytes',
  'activitypub_queue_oldest_backlog_age_seconds',
  'activitypub_queue_succeeded_in_window',
  'activitypub_queue_retry_wait_current',
  'activitypub_retry_exhausted_current',
  'activitypub_permanent_failure_in_window',
  'activitypub_origin_failure_count',
  'activitypub_inbox_authentication_failure_count',
  'activitypub_remote_http_429_in_window',
  'activitypub_remote_http_5xx_in_window',
];

const REQUIRED_ALERTS = [
  'queue_backlog_depth',
  'queue_oldest_backlog_age',
  'queue_retry_wait_current',
  'origin_failure_by_origin',
  'inbox_authentication_failure',
  'remote_http_429',
  'remote_http_5xx',
  'retry_exhausted',
  'permanent_failure',
];

const SENSITIVE_PATTERN =
  /message_json|payload_json|private_key|DATABASE_URL|response_body|responseHeaders/i;

const JOB_ALERTS = new Set([
  'queue_backlog_depth',
  'queue_oldest_backlog_age',
  'queue_retry_wait_current',
  'origin_failure_by_origin',
  'remote_http_429',
  'remote_http_5xx',
  'retry_exhausted',
  'permanent_failure',
]);

function collectSafeFilterStrings(payload: Record<string, unknown>): string[] {
  const values: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'filter' || key === 'valueExtractor' || key === 'labelExtractors') {
        values.push(JSON.stringify(nested));
      }
      walk(nested);
    }
  };
  walk(payload);
  return values;
}

function collectAlertFilters(payload: Record<string, unknown>): string[] {
  const filters: string[] = [];
  const conditions = payload.conditions;
  if (!Array.isArray(conditions)) {
    return filters;
  }
  for (const condition of conditions) {
    if (!condition || typeof condition !== 'object') {
      continue;
    }
    const threshold = (condition as { conditionThreshold?: { filter?: string } })
      .conditionThreshold;
    if (threshold?.filter) {
      filters.push(threshold.filter);
    }
  }
  return filters;
}

async function listJsonFiles(relativeDirectory: string): Promise<string[]> {
  const directory = join(observabilityRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);
}

async function runApply(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn('bash', [applyScript, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  return { exitCode, stdout, stderr };
}

async function createFakeGcloudBin(): Promise<{
  binDir: string;
  logPath: string;
  policyCaptureDir: string;
  cleanup: () => Promise<void>;
}> {
  const binDir = await mkdtemp(join(tmpdir(), 'fake-gcloud-'));
  const logPath = join(binDir, 'gcloud.log');
  const policyCaptureDir = join(binDir, 'policy-captures');
  await copyFile(fakeGcloudFixture, join(binDir, 'gcloud'));
  await chmod(join(binDir, 'gcloud'), 0o755);
  await writeFile(logPath, '', 'utf8');
  return {
    binDir,
    logPath,
    policyCaptureDir,
    cleanup: async () => {
      await rm(binDir, { recursive: true, force: true });
    },
  };
}

function fakeGcloudEnv(
  fake: { binDir: string; logPath: string; policyCaptureDir: string },
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    FAKE_GCLOUD_LOG_PATH: fake.logPath,
    FAKE_GCLOUD_POLICY_CAPTURE_DIR: fake.policyCaptureDir,
    PATH: `${fake.binDir}:${process.env.PATH}`,
  };
}

async function assertCapturedPolicyNotificationChannels(
  captureDir: string,
  channels: readonly string[],
  expectedCount: number,
): Promise<void> {
  const files = (await readdir(captureDir)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, expectedCount);
  for (const file of files) {
    const raw = await readFile(join(captureDir, file), 'utf8');
    const parsed = JSON.parse(raw) as { notificationChannels?: string[] };
    assert.deepEqual(parsed.notificationChannels, [...channels]);
    assert.equal(new Set(parsed.notificationChannels).size, channels.length);
  }
}

test('activitypub observability definitions include required metrics and bounded labels', async () => {
  const metricFiles = await listJsonFiles('log-metrics');
  assert.deepEqual(
    metricFiles.map((file) => file.replace(/\.json$/, '')).sort(),
    [...REQUIRED_METRICS].sort(),
  );

  for (const fileName of metricFiles) {
    const raw = await readFile(join(observabilityRoot, 'log-metrics', fileName), 'utf8');
    const parsed = JSON.parse(raw) as {
      filter?: string;
      metricDescriptor?: { metricKind?: string; valueType?: string };
    };
    assert.match(parsed.filter ?? '', /jsonPayload\.event=/);
    if (parsed.metricDescriptor?.valueType === 'DISTRIBUTION') {
      assert.equal(parsed.metricDescriptor.metricKind, 'DELTA');
    }
    if (fileName.includes('request') || fileName.includes('inbox_authentication')) {
      assert.match(parsed.filter ?? '', /resource\.type="cloud_run_revision"/);
    } else {
      assert.match(parsed.filter ?? '', /resource\.type="cloud_run_job"/);
    }
    for (const safeValue of collectSafeFilterStrings(parsed)) {
      assert.doesNotMatch(safeValue, SENSITIVE_PATTERN);
    }
  }
});

test('activitypub observability alert policies use safe Cloud Run resource filters', async () => {
  const alertFiles = await listJsonFiles('alert-policies');
  assert.deepEqual(
    alertFiles.map((file) => file.replace(/\.json$/, '')).sort(),
    [...REQUIRED_ALERTS].sort(),
  );

  for (const fileName of alertFiles) {
    const raw = await readFile(join(observabilityRoot, 'alert-policies', fileName), 'utf8');
    const parsed = JSON.parse(raw) as {
      alertStrategy?: { notificationRateLimit?: { period?: string }; autoClose?: string };
      userLabels?: Record<string, string>;
      conditions?: unknown[];
    };
    for (const safeValue of collectSafeFilterStrings(parsed)) {
      assert.doesNotMatch(safeValue, SENSITIVE_PATTERN);
    }
    assert.equal(parsed.alertStrategy?.notificationRateLimit?.period, '300s');
    assert.equal(parsed.alertStrategy?.autoClose, '604800s');
    assert.equal(parsed.userLabels?.pufu_lens_component, 'activitypub');

    const alertKey = fileName.replace(/\.json$/, '');
    const filters = collectAlertFilters(parsed);
    assert.ok(filters.length > 0);
    for (const filter of filters) {
      assert.doesNotMatch(filter, /resource\.type="global"/);
      if (alertKey === 'inbox_authentication_failure') {
        assert.match(filter, /resource\.type="cloud_run_revision"/);
      } else if (JOB_ALERTS.has(alertKey)) {
        assert.match(filter, /resource\.type="cloud_run_job"/);
      }
      if (alertKey === 'queue_backlog_depth') {
        assert.match(filter, /activitypub_queue_depth_total/);
      }
      if (alertKey === 'origin_failure_by_origin') {
        assert.match(filter, /activitypub_origin_failure_count/);
        const aggregations = (
          parsed.conditions as
            | Array<{ conditionThreshold?: { aggregations?: unknown[] } }>
            | undefined
        )?.[0]?.conditionThreshold?.aggregations;
        assert.ok(Array.isArray(aggregations) && aggregations.length > 0);
        const aggregationJson = JSON.stringify(aggregations);
        assert.match(aggregationJson, /metric\.label\.origin/);
        assert.match(aggregationJson, /ALIGN_PERCENTILE_95/);
        assert.doesNotMatch(aggregationJson, /ALIGN_DELTA/);
      }
    }
  }
});

test('activitypub observability apply.sh dry-run validates project and invokes gcloud zero times', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const missingProject = await runApply([], fakeGcloudEnv(fake, { TMPDIR: tempRoot }));
    assert.notEqual(missingProject.exitCode, 0);
    assert.match(missingProject.stderr, /project is required/i);

    const invalidProject = await runApply(
      ['--project', 'INVALID'],
      fakeGcloudEnv(fake, { TMPDIR: tempRoot }),
    );
    assert.notEqual(invalidProject.exitCode, 0);
    assert.match(invalidProject.stderr, /invalid --project/i);

    const dryRun = await runApply(
      ['--project', 'pufu-lens-test'],
      fakeGcloudEnv(fake, { TMPDIR: tempRoot }),
    );
    assert.equal(dryRun.exitCode, 0);
    assert.match(dryRun.stdout, /Dry run only/i);
    assert.match(dryRun.stdout, /describe exact name/);
    assert.match(dryRun.stdout, /list by userLabels\.pufu_lens_alert=/);
    assert.doesNotMatch(dryRun.stdout, /--user-labels=/);
    assert.doesNotMatch(dryRun.stdout, /try update, else create/);
    const log = await readFile(fake.logPath, 'utf8');
    assert.equal(log.trim(), '');
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh create path uses metric and policy create only', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const result = await runApply(
      ['--project', 'pufu-lens-test', '--apply'],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_POLICY_LIST_RESULT: '',
      }),
    );
    assert.equal(result.exitCode, 0);
    const log = await readFile(fake.logPath, 'utf8');
    assert.match(log, /--filter=name=activitypub_request_count/);
    assert.match(log, /logging metrics create/);
    assert.match(log, /monitoring policies create/);
    assert.doesNotMatch(log, /logging metrics update/);
    assert.doesNotMatch(log, /monitoring policies update/);
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh update path uses positional metric and policy names', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  const policyName = 'projects/pufu-lens-test/alertPolicies/queue-backlog';
  const channels = [
    'projects/pufu-lens-test/notificationChannels/channel-a',
    'projects/pufu-lens-test/notificationChannels/channel-b',
  ] as const;
  try {
    const result = await runApply(
      [
        '--project',
        'pufu-lens-test',
        '--apply',
        '--notification-channel',
        channels[0],
        '--notification-channel',
        channels[1],
      ],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_EXISTING_METRICS: 'all',
        GCLOUD_POLICY_LIST_RESULT: policyName,
      }),
    );
    assert.equal(result.exitCode, 0);
    const log = await readFile(fake.logPath, 'utf8');
    assert.match(log, /--filter=name=activitypub_request_count/);
    assert.match(log, /logging metrics update activitypub_request_count /);
    assert.doesNotMatch(log, /logging metrics create/);
    assert.equal(log.includes(`monitoring policies update ${policyName} `), true);
    assert.doesNotMatch(log, /monitoring policies create/);
    await assertCapturedPolicyNotificationChannels(
      fake.policyCaptureDir,
      channels,
      REQUIRED_ALERTS.length,
    );
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh renders multiple notification channels', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  const channels = [
    'projects/pufu-lens-test/notificationChannels/channel-a',
    'projects/pufu-lens-test/notificationChannels/channel-b',
  ] as const;
  try {
    const result = await runApply(
      [
        '--project',
        'pufu-lens-test',
        '--apply',
        '--notification-channel',
        channels[0],
        '--notification-channel',
        channels[1],
      ],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_POLICY_LIST_RESULT: '',
      }),
    );
    assert.equal(result.exitCode, 0);
    const log = await readFile(fake.logPath, 'utf8');
    assert.match(log, /monitoring policies create/);
    await assertCapturedPolicyNotificationChannels(
      fake.policyCaptureDir,
      channels,
      REQUIRED_ALERTS.length,
    );
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh fails closed on duplicate policies', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const result = await runApply(
      ['--project', 'pufu-lens-test', '--apply'],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_POLICY_LIST_RESULT: 'duplicate',
      }),
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /multiple alert policies found/i);
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh fails closed on metric lookup failure', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const result = await runApply(
      ['--project', 'pufu-lens-test', '--apply'],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_METRIC_LIST_MODE: 'fail',
      }),
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /metric lookup failed/i);
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh fails closed on duplicate metrics', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const result = await runApply(
      ['--project', 'pufu-lens-test', '--apply'],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_METRIC_LIST_MODE: 'duplicate',
      }),
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /multiple log metrics found/i);
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh fails closed on metric name mismatch', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const result = await runApply(
      ['--project', 'pufu-lens-test', '--apply'],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_METRIC_LIST_MODE: 'mismatch',
      }),
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /log metric name mismatch/i);
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});

test('activitypub observability apply.sh fails closed on policy lookup failure', async () => {
  const fake = await createFakeGcloudBin();
  const tempRoot = await mkdtemp(join(tmpdir(), 'apply-tmp-root-'));
  try {
    const result = await runApply(
      ['--project', 'pufu-lens-test', '--apply'],
      fakeGcloudEnv(fake, {
        TMPDIR: tempRoot,
        GCLOUD_EXISTING_METRICS: 'all',
        GCLOUD_POLICY_LIST_MODE: 'fail',
      }),
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /alert policy lookup failed/i);
    const tempEntries = await readdir(tempRoot);
    assert.deepEqual(tempEntries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await fake.cleanup();
  }
});
