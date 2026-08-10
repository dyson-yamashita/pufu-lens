import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryHeartbeatController } from './delivery-heartbeat.ts';

test('createDeliveryHeartbeatController awaits in-flight heartbeat before reporting lease loss', async () => {
  let resolveHeartbeat: ((value: boolean) => void) | undefined;
  const controller = createDeliveryHeartbeatController({
    heartbeat: () =>
      new Promise<boolean>((resolve) => {
        resolveHeartbeat = resolve;
      }),
    messageId: 'message-1',
    workerToken: 'token-1',
    heartbeatIntervalMs: 1,
  });
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolveHeartbeat?.(false);
  const heartbeatLost = await controller.stop();
  assert.equal(heartbeatLost, true);
});

test('createDeliveryHeartbeatController treats rejected heartbeats as lease loss without unhandled rejection', async () => {
  let rejectHeartbeat: ((reason?: unknown) => void) | undefined;
  const controller = createDeliveryHeartbeatController({
    heartbeat: () =>
      new Promise<boolean>((_resolve, reject) => {
        rejectHeartbeat = reject;
      }),
    messageId: 'message-1',
    workerToken: 'token-1',
    heartbeatIntervalMs: 1,
  });
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  rejectHeartbeat?.(new Error('lease extension failed'));
  const heartbeatLost = await controller.stop();
  assert.equal(heartbeatLost, true);
});

test('createDeliveryHeartbeatController does not overlap heartbeat calls', async () => {
  let active = 0;
  let maxActive = 0;
  const controller = createDeliveryHeartbeatController({
    heartbeat: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return true;
    },
    messageId: 'message-1',
    workerToken: 'token-1',
    heartbeatIntervalMs: 1,
  });
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const heartbeatLost = await controller.stop();
  assert.equal(heartbeatLost, false);
  assert.equal(maxActive, 1);
});
