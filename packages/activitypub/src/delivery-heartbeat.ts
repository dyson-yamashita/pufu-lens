/** Coordinates bounded delivery heartbeats without overlapping lease extensions. */
export type DeliveryHeartbeatController = {
  readonly start: () => void;
  readonly stop: () => Promise<boolean>;
};

/** Creates a heartbeat controller that never overlaps in-flight lease extensions. */
export function createDeliveryHeartbeatController(input: {
  readonly heartbeat: (args: { messageId: string; workerToken: string }) => Promise<boolean>;
  readonly messageId: string;
  readonly workerToken: string;
  readonly heartbeatIntervalMs: number;
}): DeliveryHeartbeatController {
  let heartbeatLost = false;
  let inFlightHeartbeat: Promise<boolean> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const runHeartbeat = async () => {
    const current = input.heartbeat({
      messageId: input.messageId,
      workerToken: input.workerToken,
    });
    inFlightHeartbeat = current;
    try {
      const ok = await current;
      if (!ok) {
        heartbeatLost = true;
      }
      return ok;
    } catch {
      heartbeatLost = true;
      return false;
    } finally {
      if (inFlightHeartbeat === current) {
        inFlightHeartbeat = null;
      }
    }
  };

  return {
    start() {
      heartbeatTimer = setInterval(() => {
        if (!inFlightHeartbeat) {
          void runHeartbeat();
        }
      }, input.heartbeatIntervalMs);
    },
    async stop() {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
      }
      if (inFlightHeartbeat) {
        try {
          const ok = await inFlightHeartbeat;
          if (!ok) {
            heartbeatLost = true;
          }
        } catch {
          heartbeatLost = true;
        }
      }
      return heartbeatLost;
    },
  };
}
