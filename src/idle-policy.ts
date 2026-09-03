export function healthyHeartbeatUpdate(now = new Date()): Record<string, unknown> {
  // A successful health check proves availability, not activity. In particular,
  // it must not clear idleSince or an idle worker will never reach its timeout.
  return {
    state: 'RUNNING',
    healthStatus: 'HEALTHY',
    consecutiveFailures: 0,
    lastHeartbeatAt: now,
  };
}

export function idleTimeoutElapsed(idleSince: Date | string, timeoutSeconds: number, nowMs = Date.now()): boolean {
  return nowMs - new Date(idleSince).getTime() >= timeoutSeconds * 1000;
}
