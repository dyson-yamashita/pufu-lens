import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInboundReportFollowLockRow } from './federated-report-repository.ts';

test('parseInboundReportFollowLockRow parses follow lock rows', () => {
  const parsed = parseInboundReportFollowLockRow({
    id: '4f000000-0000-0000-0000-00000000db23',
    project_id: '4f000000-0000-0000-0000-00000000db21',
  });
  assert.equal(parsed.followId, '4f000000-0000-0000-0000-00000000db23');
  assert.equal(parsed.projectId, '4f000000-0000-0000-0000-00000000db21');
});
