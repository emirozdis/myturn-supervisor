import { PoolClient } from 'pg';
import { pool, transaction } from './db';
import { InstanceRow, MachineClassification, MissionRow, SupervisorPolicy, VastOffer, WorkerLogInput } from './types';

function policyFromRow(row: Record<string, unknown>): SupervisorPolicy {
  return {
    enabled: Boolean(row.enabled),
    maxHourlyPrice: Number(row.maxHourlyPrice),
    verifiedOnly: Boolean(row.verifiedOnly),
    datacenterOnly: Boolean(row.datacenterOnly),
    requireFullMachine: Boolean(row.requireFullMachine),
    allowedGpuModels: Array.isArray(row.allowedGpuModels) ? row.allowedGpuModels.map(String) : [],
    minimumGpuRamMb: Number(row.minimumGpuRamMb),
    minimumCpuCores: Number(row.minimumCpuCores),
    minimumRamMb: Number(row.minimumRamMb),
    minimumReliability: Number(row.minimumReliability),
    minimumDownloadMbps: Number(row.minimumDownloadMbps),
    minimumUploadMbps: Number(row.minimumUploadMbps),
    diskGb: Number(row.diskGb),
    offerSearchLimit: Number(row.offerSearchLimit),
    maxWorkers: Number(row.maxWorkers),
    jobsPerWorker: Number(row.jobsPerWorker),
    queueDepthPerNewWorker: Number(row.queueDepthPerNewWorker),
    idleTimeoutSeconds: Number(row.idleTimeoutSeconds),
    idleAction: row.idleAction === 'STOP' ? 'STOP' : 'DESTROY',
    startupTimeoutSeconds: Number(row.startupTimeoutSeconds),
    healthPollSeconds: Number(row.healthPollSeconds),
    maxInstanceFailures: Number(row.maxInstanceFailures),
    maxMissionAttempts: Number(row.maxMissionAttempts),
    missionTimeoutSeconds: Number(row.missionTimeoutSeconds || 1800),
    workerLogRetentionDays: Number(row.workerLogRetentionDays),
    vastTemplateHash: String(row.vastTemplateHash || ''),
    policyVersion: Number(row.policyVersion),
  };
}

export async function insertWorkerLogs(logs: WorkerLogInput[]): Promise<number> {
  if (!logs.length) return 0;
  return transaction(async (client) => {
    let inserted = 0;
    for (const log of logs) {
      const result = await client.query(`INSERT INTO "transcoder_worker_logs"
        (id, "instanceId", "vastInstanceId", "instanceLabel", "jobId", level, message, service, "correlationId", context, "occurredAt")
        VALUES ($1, (SELECT id FROM "transcoder_instances" WHERE "vastInstanceId"=$2 LIMIT 1), $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        ON CONFLICT (id) DO NOTHING`, [
        log.id, log.vastInstanceId || null, log.instanceLabel || null, log.jobId || null,
        log.level, log.message, log.service, log.correlationId || null,
        JSON.stringify(log.context || {}), log.timestamp,
      ]);
      inserted += result.rowCount || 0;
    }
    return inserted;
  });
}

export async function cleanupWorkerLogs(retentionDays: number): Promise<number> {
  const result = await pool.query(`DELETE FROM "transcoder_worker_logs" WHERE "occurredAt" < now() - ($1 || ' days')::interval`, [String(retentionDays)]);
  return result.rowCount || 0;
}

export async function getPolicy(): Promise<SupervisorPolicy | null> {
  const result = await pool.query('SELECT * FROM "transcoder_supervisor_config" WHERE id = $1', ['default']);
  return result.rows[0] ? policyFromRow(result.rows[0]) : null;
}

export async function registerMission(input: { externalId: string; entityType: string; payload: Record<string, unknown>; priority: number }): Promise<MissionRow> {
  const result = await pool.query(`
    INSERT INTO "transcoder_missions" ("externalId", "entityType", payload, priority)
    VALUES ($1, $2, $3::jsonb, $4)
    ON CONFLICT ("externalId") DO UPDATE SET
      payload = CASE WHEN "transcoder_missions".status IN ('QUEUED','RETRY_WAIT') THEN EXCLUDED.payload ELSE "transcoder_missions".payload END,
      priority = GREATEST("transcoder_missions".priority, EXCLUDED.priority),
      "availableAt" = CASE WHEN "transcoder_missions".status IN ('QUEUED','RETRY_WAIT') THEN now() ELSE "transcoder_missions"."availableAt" END,
      "updatedAt" = now()
    RETURNING id, "externalId", "entityType", payload, status, attempts, "assignedInstanceId"
  `, [input.externalId, input.entityType, JSON.stringify(input.payload), input.priority]);
  return result.rows[0] as MissionRow;
}

export async function writeEvent(input: {
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  code: string;
  message: string;
  missionId?: string;
  instanceId?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(`INSERT INTO "transcoder_supervisor_events" (severity, code, message, "missionId", "instanceId", context)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [
    input.severity, input.code, input.message, input.missionId || null, input.instanceId || null, JSON.stringify(input.context || {}),
  ]);
}

export async function withOrchestratorLock<T>(work: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
  const client = await pool.connect();
  try {
    // Transaction-scoped locks are safe with Supabase/Supavisor transaction
    // pooling. A session lock can be acquired and released on different pooled
    // PostgreSQL sessions, leaving an invisible lock behind forever. The v2 key
    // also avoids any session lock stranded by deployments before this fix.
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', ['myturn:vast-supervisor:v2']);
    if (!lock.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      return { acquired: false };
    }
    try {
      const result = await work();
      await client.query('COMMIT');
      return { acquired: true, result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function listManagedInstances(): Promise<Array<InstanceRow & { createdAt: Date }>> {
  const result = await pool.query(`SELECT id, "vastInstanceId", state, "workerUrl", "healthStatus", "consecutiveFailures", "idleSince", "createdAt"
    FROM "transcoder_instances" WHERE state NOT IN ('DESTROYED','REPLACED') ORDER BY "createdAt"`);
  return result.rows;
}

export async function createManagedInstance(vastInstanceId: number, offer: VastOffer, classification: MachineClassification): Promise<InstanceRow> {
  const result = await pool.query(`INSERT INTO "transcoder_instances"
    ("vastInstanceId", "offerId", "machineId", state, "gpuName", "hourlyPrice", "fullMachine", classification, "rawState")
    VALUES ($1,$2,$3,'PROVISIONING',$4,$5,$6,$7::jsonb,$8::jsonb)
    RETURNING id, "vastInstanceId", state, "workerUrl", "healthStatus", "consecutiveFailures", "idleSince"`, [
    vastInstanceId, offer.id, offer.machine_id || null, offer.gpu_name || null, offer.dph_total || null,
    classification.fullMachine, JSON.stringify(classification), JSON.stringify(offer),
  ]);
  return result.rows[0];
}

export async function updateInstance(instanceId: string, fields: Record<string, unknown>): Promise<void> {
  const allowed = new Set(['state','workerUrl','healthStatus','consecutiveFailures','lastHeartbeatAt','idleSince','startedAt','terminatedAt','lastError','rawState']);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const assignments = entries.map(([key], index) => `"${key}" = $${index + 2}${key === 'rawState' ? '::jsonb' : ''}`);
  const values = entries.map(([key, value]) => key === 'rawState' ? JSON.stringify(value) : value);
  await pool.query(`UPDATE "transcoder_instances" SET ${assignments.join(', ')}, "updatedAt"=now() WHERE id=$1`, [instanceId, ...values]);
}

export async function incrementInstanceFailure(instanceId: string, message: string): Promise<number> {
  const result = await pool.query(`UPDATE "transcoder_instances" SET "consecutiveFailures"="consecutiveFailures"+1,
    "healthStatus"='UNHEALTHY', "lastError"=$2, "updatedAt"=now() WHERE id=$1 RETURNING "consecutiveFailures"`, [instanceId, message]);
  return Number(result.rows[0]?.consecutiveFailures || 0);
}

export async function recordInstanceJobFailure(instanceId: string, message: string): Promise<number> {
  const result = await pool.query(`UPDATE "transcoder_instances" SET "failedJobs"="failedJobs"+1,
    "consecutiveFailures"="consecutiveFailures"+1, "healthStatus"='UNHEALTHY', "lastError"=$2,
    "updatedAt"=now() WHERE id=$1 RETURNING "consecutiveFailures"`, [instanceId, message]);
  return Number(result.rows[0]?.consecutiveFailures || 0);
}

export async function queuedMissionCount(): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS count FROM "transcoder_missions" WHERE status IN ('QUEUED','RETRY_WAIT') AND "availableAt" <= now()`);
  return Number(result.rows[0]?.count || 0);
}

export async function activeMissionCount(instanceId: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS count FROM "transcoder_missions" WHERE "assignedInstanceId"=$1 AND status IN ('CLAIMED','DISPATCHED','PROCESSING')`, [instanceId]);
  return Number(result.rows[0]?.count || 0);
}

export async function claimMission(instanceId: string): Promise<MissionRow | null> {
  return transaction(async (client: PoolClient) => {
    // Lock and verify the worker in the same transaction that claims the
    // mission. This prevents a stale in-memory fleet snapshot from assigning
    // work after replacement or idle shutdown has started.
    const usableInstance = await client.query(`SELECT id FROM "transcoder_instances"
      WHERE id=$1 AND state='RUNNING' AND "healthStatus"='HEALTHY'
      FOR UPDATE`, [instanceId]);
    if (!usableInstance.rows[0]) return null;

    const selected = await client.query(`SELECT id FROM "transcoder_missions"
      WHERE status IN ('QUEUED','RETRY_WAIT') AND "availableAt" <= now()
      ORDER BY priority DESC, "registeredAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1`);
    const id = selected.rows[0]?.id;
    if (!id) return null;
    const result = await client.query(`UPDATE "transcoder_missions" SET status='CLAIMED', "assignedInstanceId"=$2,
      attempts=attempts+1, "updatedAt"=now() WHERE id=$1
      RETURNING id, "externalId", "entityType", payload, status, attempts, "assignedInstanceId"`, [id, instanceId]);
    return result.rows[0] as MissionRow;
  });
}

export async function beginIdleTermination(instanceId: string): Promise<boolean> {
  return transaction(async (client: PoolClient) => {
    // claimMission locks this same row before assigning work. Whichever
    // transaction acquires it first wins: a completed claim makes this active
    // check fail, while STOPPING makes a later claim fail its state check.
    const instance = await client.query(`SELECT id FROM "transcoder_instances"
      WHERE id=$1 AND state='RUNNING' AND "healthStatus"='HEALTHY'
      FOR UPDATE`, [instanceId]);
    if (!instance.rows[0]) return false;

    const active = await client.query(`SELECT 1 FROM "transcoder_missions"
      WHERE "assignedInstanceId"=$1 AND status IN ('CLAIMED','DISPATCHED','PROCESSING')
      LIMIT 1`, [instanceId]);
    if (active.rows[0]) return false;

    const result = await client.query(`UPDATE "transcoder_instances"
      SET state='STOPPING', "updatedAt"=now()
      WHERE id=$1 AND state='RUNNING' AND "healthStatus"='HEALTHY'
      RETURNING id`, [instanceId]);
    return (result.rowCount || 0) === 1;
  });
}

export async function setMissionProcessing(missionId: string): Promise<void> {
  await pool.query(`UPDATE "transcoder_missions" SET status='PROCESSING', "dispatchedAt"=now(), "updatedAt"=now() WHERE id=$1`, [missionId]);
}

export async function completeMission(missionId: string, instanceId: string): Promise<void> {
  await transaction(async (client) => {
    await client.query(`UPDATE "transcoder_missions" SET status='SUCCEEDED', "completedAt"=now(), "updatedAt"=now() WHERE id=$1 AND status <> 'SUCCEEDED'`, [missionId]);
    await client.query(`UPDATE "transcoder_instances" SET "successfulJobs"="successfulJobs"+1, "consecutiveFailures"=0, "updatedAt"=now() WHERE id=$1`, [instanceId]);
  });
}

export async function failMission(mission: MissionRow, policy: SupervisorPolicy, code: string, message: string): Promise<'RETRY_WAIT' | 'FAILED_PERMANENTLY'> {
  const terminal = mission.attempts >= policy.maxMissionAttempts;
  const status = terminal ? 'FAILED_PERMANENTLY' : 'RETRY_WAIT';
  const delaySeconds = Math.min(300, Math.max(5, 5 * 2 ** Math.max(0, mission.attempts - 1)));
  await pool.query(`UPDATE "transcoder_missions" SET status=$2, "assignedInstanceId"=NULL,
    "lastErrorCode"=$3, "lastErrorMessage"=$4, "availableAt"=now()+($5 || ' seconds')::interval,
    "completedAt"=CASE WHEN $2='FAILED_PERMANENTLY' THEN now() ELSE NULL END, "updatedAt"=now() WHERE id=$1`,
  [mission.id, status, code, message.slice(0, 4000), String(delaySeconds)]);
  return status;
}

export async function retryMissionInfrastructure(mission: MissionRow, code: string, message: string): Promise<void> {
  const delaySeconds = Math.min(300, Math.max(5, 5 * 2 ** Math.max(0, Math.min(6, mission.attempts - 1))));
  await pool.query(`UPDATE "transcoder_missions" SET status='RETRY_WAIT', "assignedInstanceId"=NULL,
    "lastErrorCode"=$2, "lastErrorMessage"=$3, "availableAt"=now()+($4 || ' seconds')::interval,
    "completedAt"=NULL, "updatedAt"=now() WHERE id=$1`,
  [mission.id, code, message.slice(0, 4000), String(delaySeconds)]);
}

export async function requeueInstanceMissions(instanceId: string, reason: string): Promise<number> {
  const result = await pool.query(`UPDATE "transcoder_missions" SET status='RETRY_WAIT', "assignedInstanceId"=NULL,
    "lastErrorCode"='INSTANCE_REPLACED', "lastErrorMessage"=$2, "availableAt"=now()+interval '5 seconds', "updatedAt"=now()
    WHERE "assignedInstanceId"=$1 AND status IN ('CLAIMED','DISPATCHED','PROCESSING')`, [instanceId, reason.slice(0, 4000)]);
  return result.rowCount || 0;
}

export async function activeAssignedMissions(): Promise<MissionRow[]> {
  const result = await pool.query(`SELECT id, "externalId", "entityType", payload, status, attempts, "assignedInstanceId", "dispatchedAt"
    FROM "transcoder_missions"
    WHERE status IN ('CLAIMED','DISPATCHED','PROCESSING') AND "assignedInstanceId" IS NOT NULL
    ORDER BY "dispatchedAt" NULLS FIRST, "registeredAt"`);
  return result.rows;
}

export async function supervisorSnapshot(): Promise<Record<string, unknown>> {
  const [missions, instances, recentEvents] = await Promise.all([
    pool.query(`SELECT status, count(*)::int AS count FROM "transcoder_missions" GROUP BY status`),
    pool.query(`SELECT state, "healthStatus", count(*)::int AS count FROM "transcoder_instances" GROUP BY state, "healthStatus"`),
    pool.query(`SELECT severity, code, message, "createdAt" FROM "transcoder_supervisor_events" ORDER BY "createdAt" DESC LIMIT 20`),
  ]);
  return { missions: missions.rows, instances: instances.rows, recentEvents: recentEvents.rows };
}
