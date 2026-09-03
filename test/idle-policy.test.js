const test = require('node:test');
const assert = require('node:assert/strict');

const { healthyHeartbeatUpdate, idleTimeoutElapsed } = require('../dist/idle-policy.js');

test('healthy worker polling preserves the existing idle timer', () => {
  const update = healthyHeartbeatUpdate(new Date('2026-08-09T14:30:00.000Z'));
  assert.equal(Object.hasOwn(update, 'idleSince'), false);
  assert.equal(update.healthStatus, 'HEALTHY');
  assert.equal(update.state, 'RUNNING');
});

test('idle timeout becomes eligible only after the configured duration', () => {
  const idleSince = new Date('2026-08-09T14:30:00.000Z');
  assert.equal(idleTimeoutElapsed(idleSince, 300, Date.parse('2026-08-09T14:34:59.999Z')), false);
  assert.equal(idleTimeoutElapsed(idleSince, 300, Date.parse('2026-08-09T14:35:00.000Z')), true);
});
