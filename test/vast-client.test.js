const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.VAST_API_KEY ||= 'test-vast-key';
process.env.SUPERVISOR_MISSION_SECRET ||= 'mission-secret-at-least-thirty-two-characters';
process.env.WORKER_LOG_INGEST_SECRET ||= 'worker-log-secret-at-least-thirty-two-characters';
process.env.TRANSCODER_API_KEY ||= 'test-worker-key';

const { classifyInstanceStatus } = require('../dist/vast-client.js');

test('treats unknown and startup statuses as transitional', () => {
  assert.equal(classifyInstanceStatus('unknown'), 'TRANSITIONAL');
  assert.equal(classifyInstanceStatus(undefined), 'TRANSITIONAL');
  assert.equal(classifyInstanceStatus('created'), 'TRANSITIONAL');
  assert.equal(classifyInstanceStatus('loading'), 'TRANSITIONAL');
});

test('only treats explicit unrecoverable statuses as terminal', () => {
  assert.equal(classifyInstanceStatus('exited'), 'TERMINAL');
  assert.equal(classifyInstanceStatus('offline'), 'TERMINAL');
  assert.equal(classifyInstanceStatus('running'), 'RUNNING');
  assert.equal(classifyInstanceStatus('stopped'), 'STOPPED');
});
