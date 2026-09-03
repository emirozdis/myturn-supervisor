const test = require('node:test');
const assert = require('node:assert/strict');

const { assignmentUnavailableReason } = require('../dist/mission-safety.js');

const running = {
  id: 'instance-1', vastInstanceId: 1, state: 'RUNNING', workerUrl: 'http://worker',
  healthStatus: 'HEALTHY', consecutiveFailures: 0, idleSince: null,
};

test('missing assignments are classified as orphaned', () => {
  assert.equal(assignmentUnavailableReason(undefined), 'assigned instance is no longer managed');
});

test('terminal and shutdown states cannot retain active missions', () => {
  for (const state of ['STOPPED', 'STOPPING', 'DESTROYED', 'REPLACED', 'REPLACING']) {
    assert.equal(assignmentUnavailableReason({ ...running, state }), `assigned instance is ${state}`);
  }
});

test('running and provisioning instances are not prematurely classified as orphaned', () => {
  assert.equal(assignmentUnavailableReason(running), null);
  assert.equal(assignmentUnavailableReason({ ...running, state: 'PROVISIONING' }), null);
});
