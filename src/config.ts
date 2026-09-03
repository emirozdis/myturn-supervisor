function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: positiveInteger('PORT', 3010),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: required('DATABASE_URL'),
  vastApiKey: required('VAST_API_KEY'),
  missionSecret: required('SUPERVISOR_MISSION_SECRET'),
  workerLogIngestSecret: required('WORKER_LOG_INGEST_SECRET'),
  workerApiKey: required('TRANSCODER_API_KEY'),
  reconcileIntervalMs: positiveInteger('RECONCILE_INTERVAL_MS', 5000),
  authMaxSkewSeconds: positiveInteger('MISSION_AUTH_MAX_SKEW_SECONDS', 300),
  logLevel: process.env.LOG_LEVEL || 'info',
};

if (config.missionSecret.length < 32) throw new Error('SUPERVISOR_MISSION_SECRET must be at least 32 characters');
if (config.workerLogIngestSecret.length < 32) throw new Error('WORKER_LOG_INGEST_SECRET must be at least 32 characters');
