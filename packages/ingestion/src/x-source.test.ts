import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveXSyncWindow } from './x-source.js';

test('initial X sync includes yesterday and has no lower bound', () => {
  assert.deepEqual(resolveXSyncWindow(new Date('2026-08-18T14:30:00Z'), true), {
    endTime: '2026-08-18T00:00:00.000Z',
  });
});

test('periodic X sync reads exactly the previous UTC day', () => {
  assert.deepEqual(resolveXSyncWindow(new Date('2026-08-18T14:30:00Z'), false), {
    endTime: '2026-08-18T00:00:00.000Z',
    startTime: '2026-08-17T00:00:00.000Z',
  });
});
