const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.VAST_API_KEY ||= 'test-vast-key';
process.env.SUPERVISOR_MISSION_SECRET ||= 'mission-secret-at-least-thirty-two-characters';
process.env.WORKER_LOG_INGEST_SECRET ||= 'worker-log-secret-at-least-thirty-two-characters';
process.env.TRANSCODER_API_KEY ||= 'test-worker-key';

const { verifySignedRequest } = require('../dist/auth.js');

test('verifies worker log batches with their independent HMAC secret', () => {
  const body = Buffer.from('{"logs":[]}');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = randomUUID();
  const secret = process.env.WORKER_LOG_INGEST_SECRET;
  const signature = createHmac('sha256', secret).update(`${timestamp}.${requestId}.`).update(body).digest('hex');
  assert.equal(verifySignedRequest(body, timestamp, requestId, `sha256=${signature}`, secret), true);
  assert.equal(verifySignedRequest(Buffer.from('{"tampered":true}'), timestamp, requestId, `sha256=${signature}`, secret), false);
});
