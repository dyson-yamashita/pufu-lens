import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  isSyntheticMonitorArtifactConsistent,
  readBoundedUtf8FromStream,
} from './synthetic-monitor-artifact.ts';
import { SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES } from './synthetic-monitor-contract.ts';

const validArtifact = {
  generated_at: '2026-07-14T01:00:00.000Z',
  period: { start: '2026-07-07', end: '2026-07-13' },
  project_id: 'project-a',
  report_id: 'report-1',
  schema_version: 'v1',
  sections: [{ id: 'progress', title: 'Progress', markdown: 'All good.' }],
  summary: 'summary',
  title: 'title',
};

test('readBoundedUtf8FromStream stops at the byte limit', async () => {
  const stream = Readable.from([Buffer.from('hello'), Buffer.from(' world')]);
  const bounded = await readBoundedUtf8FromStream(stream, 5);
  assert.equal(bounded.exceeded, true);
  assert.equal(bounded.text, '');
});

test('readBoundedUtf8FromStream accepts content exactly at the byte limit', async () => {
  const exact = 'a'.repeat(SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES);
  const bounded = await readBoundedUtf8FromStream(
    Readable.from([Buffer.from(exact)]),
    SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES,
  );
  assert.equal(bounded.exceeded, false);
  assert.equal(bounded.text.length, SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES);
});

test('readBoundedUtf8FromStream rejects content one byte over the limit', async () => {
  const oversize = 'a'.repeat(SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES + 1);
  const bounded = await readBoundedUtf8FromStream(
    Readable.from([Buffer.from(oversize)]),
    SYNTHETIC_MONITOR_ARTIFACT_MAX_BYTES,
  );
  assert.equal(bounded.exceeded, true);
  assert.equal(bounded.text, '');
});

test('isSyntheticMonitorArtifactConsistent rejects schema, report, and project mismatches', () => {
  assert.equal(
    isSyntheticMonitorArtifactConsistent({
      artifact: validArtifact,
      expectedProjectId: 'project-a',
      expectedReportId: 'report-1',
      expectedSchemaVersion: 'v1',
    }),
    true,
  );
  assert.equal(
    isSyntheticMonitorArtifactConsistent({
      artifact: { ...validArtifact, schema_version: 'v2' },
      expectedProjectId: 'project-a',
      expectedReportId: 'report-1',
      expectedSchemaVersion: 'v1',
    }),
    false,
  );
  assert.equal(
    isSyntheticMonitorArtifactConsistent({
      artifact: { ...validArtifact, report_id: 'other-report' },
      expectedProjectId: 'project-a',
      expectedReportId: 'report-1',
      expectedSchemaVersion: 'v1',
    }),
    false,
  );
  assert.equal(
    isSyntheticMonitorArtifactConsistent({
      artifact: { ...validArtifact, project_id: 'other-project' },
      expectedProjectId: 'project-a',
      expectedReportId: 'report-1',
      expectedSchemaVersion: 'v1',
    }),
    false,
  );
});
