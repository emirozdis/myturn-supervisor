import { createHmac, timingSafeEqual } from 'crypto';
import { config } from './config';

export function verifySignedRequest(rawBody: Buffer, timestamp: string | undefined, requestId: string | undefined, signature: string | undefined, secret = config.missionSecret): boolean {
  if (!timestamp || !requestId || !signature || !/^[0-9a-f-]{36}$/i.test(requestId)) return false;
  const parsed = Number(timestamp);
  if (!Number.isInteger(parsed) || Math.abs(Math.floor(Date.now() / 1000) - parsed) > config.authMaxSkewSeconds) return false;
  const hex = signature.startsWith('sha256=') ? signature.slice(7) : '';
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${requestId}.`).update(rawBody).digest();
  const received = Buffer.from(hex, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
