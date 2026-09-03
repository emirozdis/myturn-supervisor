import express, { Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'crypto';
import { verifySignedRequest } from './auth';
import { getPolicy, insertWorkerLogs, registerMission, supervisorSnapshot, writeEvent } from './repository';
import { errorContext, logger } from './logger';
import { wakeOrchestrator } from './orchestrator';
import { pool } from './db';
import { config } from './config';

export const app = express();
app.disable('x-powered-by');
app.use(helmet());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const policy = await getPolicy();
    res.status(policy ? 200 : 503).json({ status: policy ? 'healthy' : 'degraded', database: 'connected', policyConfigured: Boolean(policy?.vastTemplateHash) });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', database: 'unavailable', error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/v1/missions', express.raw({ type: 'application/json', limit: '64kb' }), async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const requestId = req.header('x-supervisor-request-id') || undefined;
  if (!verifySignedRequest(rawBody, req.header('x-supervisor-timestamp') || undefined, requestId, req.header('x-supervisor-signature') || undefined)) {
    logger.warn({ event: 'mission.authentication_failed', requestId, ip: req.ip }, 'Rejected unauthenticated mission registration');
    return res.status(401).json({ error: 'Invalid mission authentication' });
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const externalId = typeof body.externalId === 'string' ? body.externalId : '';
  const entityType = body.entityType === 'photoResponse' ? 'photoResponse' : body.entityType === 'clip' ? 'clip' : '';
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : null;
  const priority = Number.isInteger(body.priority) ? Math.max(-100, Math.min(100, Number(body.priority))) : 0;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(externalId) || !entityType || !payload || payload.jobId !== externalId) {
    return res.status(400).json({ error: 'Invalid mission payload' });
  }
  try {
    const mission = await registerMission({ externalId, entityType, payload, priority });
    await writeEvent({ severity: 'INFO', code: 'mission.registered', message: 'Mission registered through authenticated supervisor API', missionId: mission.id, context: { externalId, entityType, requestId } });
    logger.info({ event: 'mission.registered', missionId: mission.id, externalId, entityType, requestId }, 'Mission registered and supervisor awakened');
    wakeOrchestrator(`mission:${externalId}`);
    return res.status(202).json({ status: 'accepted', mission: { id: mission.id, externalId, status: mission.status } });
  } catch (error) {
    logger.error({ event: 'mission.registration_failed', externalId, requestId, ...errorContext(error) }, 'Failed to persist mission');
    return res.status(500).json({ error: 'Mission registration failed', requestId: requestId || randomUUID() });
  }
});

app.post('/v1/worker-logs', express.raw({ type: 'application/json', limit: '512kb' }), async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const requestId = req.header('x-supervisor-request-id') || undefined;
  if (!verifySignedRequest(rawBody, req.header('x-supervisor-timestamp') || undefined, requestId, req.header('x-supervisor-signature') || undefined, config.workerLogIngestSecret)) {
    logger.warn({ event: 'worker_logs.authentication_failed', requestId, ip: req.ip }, 'Rejected unauthenticated worker log batch');
    return res.status(401).json({ error: 'Invalid worker log authentication' });
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const rawLogs = Array.isArray(body.logs) ? body.logs : [];
  const instance = body.instance && typeof body.instance === 'object' && !Array.isArray(body.instance) ? body.instance as Record<string, unknown> : {};
  const vastInstanceId = Number(instance.vastInstanceId);
  const instanceLabel = typeof instance.label === 'string' ? instance.label.slice(0, 256) : undefined;
  if (!rawLogs.length || rawLogs.length > 100 || (!Number.isInteger(vastInstanceId) && !instanceLabel)) {
    return res.status(400).json({ error: 'Invalid worker log batch' });
  }
  const allowedLevels = new Set(['silly', 'debug', 'http', 'info', 'warn', 'error', 'fatal']);
  const logs = [];
  for (const raw of rawLogs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'Invalid worker log entry' });
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const timestamp = new Date(typeof item.timestamp === 'string' ? item.timestamp : '');
    const level = typeof item.level === 'string' ? item.level.toLowerCase() : '';
    const message = typeof item.message === 'string' ? item.message : '';
    const service = typeof item.service === 'string' ? item.service : 'transcoder';
    const context = item.context && typeof item.context === 'object' && !Array.isArray(item.context) ? item.context as Record<string, unknown> : {};
    if (!/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 300_000 || !allowedLevels.has(level) || !message || message.length > 20_000 || service.length > 100 || JSON.stringify(context).length > 50_000) {
      return res.status(400).json({ error: 'Invalid worker log entry' });
    }
    logs.push({
      id, timestamp, level, message, service,
      correlationId: typeof item.correlationId === 'string' ? item.correlationId.slice(0, 128) : undefined,
      jobId: typeof item.jobId === 'string' ? item.jobId.slice(0, 128) : typeof context.jobId === 'string' ? context.jobId.slice(0, 128) : undefined,
      context,
      vastInstanceId: Number.isInteger(vastInstanceId) && vastInstanceId > 0 ? vastInstanceId : undefined,
      instanceLabel,
    });
  }
  try {
    const inserted = await insertWorkerLogs(logs);
    return res.status(202).json({ status: 'accepted', received: logs.length, inserted });
  } catch (error) {
    logger.error({ event: 'worker_logs.persist_failed', requestId, count: logs.length, ...errorContext(error) }, 'Unable to persist worker log batch');
    return res.status(500).json({ error: 'Worker log persistence failed', requestId });
  }
});

app.get('/v1/snapshot', express.json(), async (req, res) => {
  // Operational snapshot uses the same signed request format with an empty
  // body. The admin UI normally reads shared PostgreSQL directly.
  if (!verifySignedRequest(Buffer.alloc(0), req.header('x-supervisor-timestamp') || undefined, req.header('x-supervisor-request-id') || undefined, req.header('x-supervisor-signature') || undefined)) {
    return res.status(401).json({ error: 'Invalid authentication' });
  }
  return res.json({ status: 'success', data: await supervisorSnapshot() });
});

app.use(express.json({ limit: '16kb' }));
app.use((error: unknown, req: Request, res: Response, _next: unknown) => {
  const requestId = req.header('x-supervisor-request-id') || randomUUID();
  logger.error({ event: 'http.unhandled_error', requestId, method: req.method, path: req.path, ...errorContext(error) }, 'Unhandled supervisor HTTP error');
  res.status(500).json({ error: 'Internal supervisor error', requestId });
});
