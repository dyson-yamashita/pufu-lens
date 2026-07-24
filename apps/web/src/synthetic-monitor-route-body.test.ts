import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYNTHETIC_MONITOR_MAX_BODY_BYTES,
  SyntheticMonitorRequestError,
} from './synthetic-monitor-contract.ts';
import {
  parseSyntheticMonitorJsonBody,
  readBoundedRequestBody,
  readSyntheticMonitorBearerToken,
} from './synthetic-monitor-route-body.ts';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text, 'utf8'));
      controller.close();
    },
  });
}

test('readBoundedRequestBody rejects Content-Length above the limit before reading', async () => {
  await assert.rejects(
    () =>
      readBoundedRequestBody({
        body: streamFromText('{}'),
        contentLength: String(SYNTHETIC_MONITOR_MAX_BODY_BYTES + 1),
      }),
    (error: unknown) =>
      error instanceof SyntheticMonitorRequestError && /64KiB/.test(error.message),
  );
});

test('readBoundedRequestBody rejects streamed bodies above the limit', async () => {
  const oversized = 'a'.repeat(SYNTHETIC_MONITOR_MAX_BODY_BYTES + 1);
  await assert.rejects(
    () =>
      readBoundedRequestBody({
        body: streamFromText(oversized),
        contentLength: null,
      }),
    /64KiB/,
  );
});

test('parseSyntheticMonitorJsonBody maps SyntaxError to a safe request error', () => {
  assert.throws(
    () => parseSyntheticMonitorJsonBody('{bad json'),
    (error: unknown) =>
      error instanceof SyntheticMonitorRequestError &&
      error.message === 'request body must be valid JSON.',
  );
});

test('readSyntheticMonitorBearerToken parses Bearer tokens without regular expressions', () => {
  assert.equal(readSyntheticMonitorBearerToken('Bearer token-a'), 'token-a');
  assert.equal(readSyntheticMonitorBearerToken('  bearer   token-b  '), 'token-b');
  assert.equal(readSyntheticMonitorBearerToken('BEARER\t\ttoken-c'), 'token-c');
  assert.equal(readSyntheticMonitorBearerToken(`Bearer ${' '.repeat(10_000)}token-d`), 'token-d');
  assert.equal(
    readSyntheticMonitorBearerToken('Bearer token-with-trailing  '),
    'token-with-trailing',
  );
});

test('readSyntheticMonitorBearerToken rejects absent or malformed Authorization values', () => {
  assert.equal(readSyntheticMonitorBearerToken(null), '');
  assert.equal(readSyntheticMonitorBearerToken(''), '');
  assert.equal(readSyntheticMonitorBearerToken('   '), '');
  assert.equal(readSyntheticMonitorBearerToken('Basic abc'), '');
  assert.equal(readSyntheticMonitorBearerToken('Bearer'), '');
  assert.equal(readSyntheticMonitorBearerToken('Bearer   '), '');
  assert.equal(readSyntheticMonitorBearerToken('BearerToken'), '');
  assert.equal(readSyntheticMonitorBearerToken(`Bearer${'\t'.repeat(5_000)}`), '');
});
