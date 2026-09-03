import { EventEmitter } from 'events';
import { config } from './config';
import { healthyHeartbeatUpdate, idleTimeoutElapsed } from './idle-policy';
import { logger, errorContext } from './logger';
import { assignmentUnavailableReason } from './mission-safety';
import {
  activeAssignedMissions, activeMissionCount, beginIdleTermination, claimMission, cleanupWorkerLogs, completeMission, createManagedInstance, failMission, getPolicy,
  incrementInstanceFailure, listManagedInstances, queuedMissionCount, recordInstanceJobFailure, requeueInstanceMissions,
  retryMissionInfrastructure, setMissionProcessing, updateInstance, withOrchestratorLock, writeEvent,
} from './repository';
import { classifyInstanceStatus, createInstance, destroyInstance, resolveWorkerUrl, searchOffers, setInstanceState, showInstance } from './vast-client';
import { selectOffers } from './offer-selector';
import { InstanceRow, MissionRow, SupervisorPolicy } from './types';

const wakeups = new EventEmitter();
let stopped = false;
let loopPromise: Promise<void> | undefined;
let lastLogCleanupAt = 0;

async function record(severity: 'DEBUG'|'INFO'|'WARN'|'ERROR'|'FATAL', code: string, message: string, context: Record<string, unknown> = {}, ids: { missionId?: string; instanceId?: string } = {}) {
  const fields = { event: code, ...ids, ...context };
  if (severity === 'ERROR' || severity === 'FATAL') logger.error(fields, message);
  else if (severity === 'WARN') logger.warn(fields, message);
  else if (severity === 'DEBUG') logger.debug(fields, message);
  else logger.info(fields, message);
  await writeEvent({ severity, code, message, context, ...ids }).catch((error) => logger.error({ event: 'event.persist_failed', ...errorContext(error) }, 'Unable to persist supervisor event'));
}

async function workerFetch(instance: InstanceRow, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  if (!instance.workerUrl) throw new Error(`Instance ${instance.vastInstanceId} has no resolved worker URL`);
  return fetch(`${instance.workerUrl}${path}`, {
    ...init,
    headers: { 'x-api-key': config.workerApiKey, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function checkWorker(instance: InstanceRow): Promise<boolean> {
  try {
    const response = await workerFetch(instance, '/api/v1/system/health', {}, 5000);
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    await updateInstance(instance.id, healthyHeartbeatUpdate());
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failures = await incrementInstanceFailure(instance.id, message);
    await record('WARN', 'worker.health_failed', 'Managed transcoder health check failed', { vastInstanceId: instance.vastInstanceId, failures, ...errorContext(error) }, { instanceId: instance.id });
    return false;
  }
}

async function syncInstance(instance: InstanceRow & { createdAt: Date }, policy: SupervisorPolicy): Promise<void> {
  if (instance.state === 'REPLACING') {
    await replaceInstance(instance, policy, instance.healthStatus === 'UNHEALTHY' ? 'retrying previously requested replacement' : 'replacement pending');
    return;
  }
  try {
    const remote = await showInstance(instance.vastInstanceId);
    const actual = String(remote.actual_status || 'unknown');
    const statusDisposition = classifyInstanceStatus(actual);
    const workerUrl = resolveWorkerUrl(remote);
    await updateInstance(instance.id, { rawState: remote, workerUrl, lastHeartbeatAt: new Date() });
    if (statusDisposition === 'RUNNING' && workerUrl) {
      const current = { ...instance, workerUrl };
      const healthy = await checkWorker(current);
      if (healthy && instance.state !== 'RUNNING') {
        await updateInstance(instance.id, { state: 'RUNNING', healthStatus: 'HEALTHY', startedAt: new Date() });
        await record('INFO', 'instance.ready', 'Vast instance is running and the transcoder passed health checks', { vastInstanceId: instance.vastInstanceId, workerUrl }, { instanceId: instance.id });
      }
      if (!healthy && instance.consecutiveFailures + 1 >= policy.maxInstanceFailures) {
        await replaceInstance(current, policy, 'repeated worker health-check failures');
      }
      return;
    }
    if (statusDisposition === 'STOPPED') {
      await updateInstance(instance.id, { state: 'STOPPED', healthStatus: 'OFFLINE', workerUrl: null });
      return;
    }
    if (statusDisposition === 'TERMINAL') {
      await replaceInstance(instance, policy, `Vast reported unrecoverable instance status: ${actual}`);
      return;
    }
    const ageSeconds = (Date.now() - new Date(instance.createdAt).getTime()) / 1000;
    if (ageSeconds > policy.startupTimeoutSeconds) {
      await replaceInstance(instance, policy, `startup timeout after ${Math.round(ageSeconds)} seconds; actual_status=${actual}`);
      return;
    }
    await updateInstance(instance.id, { state: 'PROVISIONING', healthStatus: 'STARTING' });
  } catch (error) {
    const failures = await incrementInstanceFailure(instance.id, error instanceof Error ? error.message : String(error));
    await record('ERROR', 'instance.sync_failed', 'Failed to synchronize a managed Vast instance', { vastInstanceId: instance.vastInstanceId, failures, ...errorContext(error) }, { instanceId: instance.id });
    if (failures >= policy.maxInstanceFailures) await replaceInstance(instance, policy, 'repeated Vast synchronization failures');
  }
}

async function replaceInstance(instance: InstanceRow, policy: SupervisorPolicy, reason: string): Promise<void> {
  const requeued = await requeueInstanceMissions(instance.id, reason);
  await updateInstance(instance.id, { state: 'REPLACING', healthStatus: 'UNHEALTHY', lastError: reason });
  await record('ERROR', 'instance.replacement_started', 'Unhealthy Vast instance is being removed and its missions requeued', { vastInstanceId: instance.vastInstanceId, reason, requeued }, { instanceId: instance.id });
  try { await destroyInstance(instance.vastInstanceId); }
  catch (error) { await record('ERROR', 'instance.destroy_failed', 'Vast rejected instance destruction during replacement; reconciliation will retry', { vastInstanceId: instance.vastInstanceId, ...errorContext(error) }, { instanceId: instance.id }); return; }
  await updateInstance(instance.id, { state: 'REPLACED', healthStatus: 'OFFLINE', terminatedAt: new Date() });
}

async function provision(policy: SupervisorPolicy): Promise<void> {
  if (!policy.vastTemplateHash) {
    await record('FATAL', 'policy.template_missing', 'Vast provisioning is disabled because no template hash is configured');
    return;
  }
  const offers = await searchOffers(policy);
  const candidates = selectOffers(offers, policy);
  await record('INFO', 'offer.search_completed', 'Vast offer search completed', { returned: offers.length, eligible: candidates.length, requireFullMachine: policy.requireFullMachine, policyVersion: policy.policyVersion });
  if (!candidates.length) throw new Error('No Vast offers satisfy the active supervisor policy');
  const failures: Array<Record<string, unknown>> = [];
  for (const candidate of candidates.slice(0, 10)) {
    let vastInstanceId: number | undefined;
    try {
      vastInstanceId = await createInstance(candidate.offer.id, policy);
      const instance = await createManagedInstance(vastInstanceId, candidate.offer, candidate.classification);
      await record('INFO', 'instance.provisioned', 'Accepted a Vast offer and created a managed transcoder instance', {
        vastInstanceId, offerId: candidate.offer.id, machineId: candidate.offer.machine_id, gpu: candidate.offer.gpu_name,
        hourlyPrice: candidate.offer.dph_total, selectionStrategy: 'lowest-price-qualified', classification: candidate.classification,
      }, { instanceId: instance.id });
      return;
    } catch (error) {
      if (vastInstanceId) {
        await destroyInstance(vastInstanceId).catch((cleanupError) => record('FATAL', 'instance.orphan_cleanup_failed', 'A Vast contract was created but could not be recorded or cleaned up', { vastInstanceId, offerId: candidate.offer.id, ...errorContext(cleanupError) }));
      }
      failures.push({ offerId: candidate.offer.id, ...errorContext(error) });
      await record('WARN', 'offer.accept_failed', 'Vast offer disappeared or could not be accepted; trying the next candidate', { offerId: candidate.offer.id, ...errorContext(error) });
    }
  }
  throw new Error(`Unable to accept any eligible Vast offer: ${JSON.stringify(failures).slice(0, 3000)}`);
}

async function dispatch(instance: InstanceRow, mission: MissionRow, policy: SupervisorPolicy): Promise<void> {
  try {
    const response = await workerFetch(instance, '/api/v1/videos/process-remote', { method: 'POST', body: JSON.stringify(mission.payload) }, 15_000);
    const text = await response.text();
    if (!response.ok) throw new Error(`worker dispatch returned HTTP ${response.status}: ${text.slice(0, 1500)}`);
    const body = JSON.parse(text) as { status?: string; data?: { jobId?: string } };
    if (body.status !== 'success' || body.data?.jobId !== mission.externalId) throw new Error('worker returned an invalid or mismatched dispatch acknowledgement');
    await setMissionProcessing(mission.id);
    await updateInstance(instance.id, { idleSince: null });
    await record('INFO', 'mission.dispatched', 'Mission accepted by the managed transcoder worker', { externalId: mission.externalId, vastInstanceId: instance.vastInstanceId, attempt: mission.attempts }, { missionId: mission.id, instanceId: instance.id });
  } catch (error) {
    // A timeout after the worker durably enqueued the job is an ambiguous
    // acknowledgement, not proof that dispatch failed. Resolve it before any
    // retry so another worker cannot start a duplicate transcode unnecessarily.
    try {
      const statusResponse = await workerFetch(instance, `/api/v1/videos/status/${encodeURIComponent(mission.externalId)}`, {}, 5000);
      if (statusResponse.ok) {
        const statusBody = await statusResponse.json() as { data?: { status?: string } };
        if (['PENDING', 'PROCESSING', 'COMPLETED'].includes(statusBody.data?.status || '')) {
          await setMissionProcessing(mission.id);
          await updateInstance(instance.id, { idleSince: null, consecutiveFailures: 0, healthStatus: 'HEALTHY' });
          await record('WARN', 'mission.dispatch_ack_recovered', 'Dispatch acknowledgement was ambiguous, but the worker confirms the mission is durable', { externalId: mission.externalId, workerStatus: statusBody.data?.status, originalError: errorContext(error) }, { missionId: mission.id, instanceId: instance.id });
          return;
        }
      }
    } catch (statusError) {
      await record('WARN', 'mission.dispatch_ack_check_failed', 'Could not resolve an ambiguous dispatch acknowledgement from worker state', { externalId: mission.externalId, originalError: errorContext(error), statusError: errorContext(statusError) }, { missionId: mission.id, instanceId: instance.id });
    }
    await retryMissionInfrastructure(mission, 'WORKER_DISPATCH_FAILED', error instanceof Error ? error.message : String(error));
    const failures = await incrementInstanceFailure(instance.id, error instanceof Error ? error.message : String(error));
    await record('ERROR', 'mission.dispatch_failed', 'Mission dispatch to a managed worker failed; infrastructure retries remain enabled', { externalId: mission.externalId, resultingStatus: 'RETRY_WAIT', instanceFailures: failures, ...errorContext(error) }, { missionId: mission.id, instanceId: instance.id });
    if (failures >= policy.maxInstanceFailures) await replaceInstance(instance, policy, 'repeated mission dispatch failures');
  }
}

async function reconcileJobs(instances: InstanceRow[], policy: SupervisorPolicy): Promise<void> {
  const instanceById = new Map(instances.map((item) => [item.id, item]));
  for (const mission of await activeAssignedMissions()) {
    const instance = mission.assignedInstanceId ? instanceById.get(mission.assignedInstanceId) : undefined;
    const unavailableReason = assignmentUnavailableReason(instance);
    if (unavailableReason) {
      await retryMissionInfrastructure(mission, 'ORPHANED_INSTANCE', unavailableReason);
      await record('ERROR', 'mission.orphaned_instance', 'Mission was assigned to an unavailable worker and has been requeued automatically', {
        externalId: mission.externalId,
        previousStatus: mission.status,
        assignedInstanceId: mission.assignedInstanceId,
        reason: unavailableReason,
      }, { missionId: mission.id, instanceId: mission.assignedInstanceId || undefined });
      continue;
    }
    // CLAIMED and DISPATCHED rows are included above so orphan recovery covers
    // supervisor interruption at every assignment stage. Only PROCESSING rows
    // have a worker runtime that should be polled here.
    if (mission.status !== 'PROCESSING') continue;
    if (!instance?.workerUrl || instance.healthStatus !== 'HEALTHY') continue;
    const runtimeSeconds = mission.dispatchedAt ? (Date.now() - new Date(mission.dispatchedAt).getTime()) / 1000 : 0;
    if (runtimeSeconds > policy.missionTimeoutSeconds) {
      await record('ERROR', 'mission.runtime_timeout', 'Mission exceeded its maximum runtime; the worker will be replaced and assigned missions requeued', {
        externalId: mission.externalId,
        vastInstanceId: instance.vastInstanceId,
        runtimeSeconds: Math.round(runtimeSeconds),
        timeoutSeconds: policy.missionTimeoutSeconds,
      }, { missionId: mission.id, instanceId: instance.id });
      await replaceInstance(instance, policy, `mission ${mission.externalId} exceeded runtime timeout of ${policy.missionTimeoutSeconds} seconds`);
      return;
    }
    try {
      const response = await workerFetch(instance, `/api/v1/videos/status/${encodeURIComponent(mission.externalId)}`, {}, 5000);
      if (!response.ok) continue;
      const body = await response.json() as { data?: { status?: string; error?: string } };
      if (body.data?.status === 'COMPLETED') {
        await completeMission(mission.id, instance.id);
        await record('INFO', 'mission.completed', 'Managed worker reports mission completion', { externalId: mission.externalId }, { missionId: mission.id, instanceId: instance.id });
      } else if (body.data?.status === 'FAILED') {
        const status = await failMission(mission, policy, 'WORKER_JOB_FAILED', body.data.error || 'Worker reported an unspecified processing failure');
        const failures = await recordInstanceJobFailure(instance.id, body.data.error || 'worker job failed');
        await record('ERROR', 'mission.processing_failed', 'Managed worker reports mission failure', { externalId: mission.externalId, resultingStatus: status, instanceFailures: failures, workerError: body.data.error }, { missionId: mission.id, instanceId: instance.id });
        if (failures >= policy.maxInstanceFailures) {
          await replaceInstance(instance, policy, 'repeated processing failures');
          // Replacement changes fleet state and may requeue other missions in
          // this snapshot. Stop processing it and let the caller reload state.
          return;
        }
      }
    } catch (error) {
      await record('WARN', 'mission.status_poll_failed', 'Unable to read mission state from worker; mission remains assigned', { externalId: mission.externalId, ...errorContext(error) }, { missionId: mission.id, instanceId: instance.id });
    }
  }
}

async function stopIdleInstances(instances: InstanceRow[], policy: SupervisorPolicy): Promise<void> {
  if (await queuedMissionCount() > 0) return;
  for (const instance of instances.filter((item) => item.state === 'RUNNING' && item.healthStatus === 'HEALTHY')) {
    if (await activeMissionCount(instance.id) > 0) {
      if (instance.idleSince) await updateInstance(instance.id, { idleSince: null });
      continue;
    }
    if (!instance.idleSince) {
      const idleSince = new Date();
      await updateInstance(instance.id, { idleSince });
      await record('INFO', 'instance.idle_countdown_started', 'Managed worker became idle; termination countdown started', {
        vastInstanceId: instance.vastInstanceId,
        idleTimeoutSeconds: policy.idleTimeoutSeconds,
        idleAction: policy.idleAction,
        deadline: new Date(idleSince.getTime() + policy.idleTimeoutSeconds * 1000).toISOString(),
      }, { instanceId: instance.id });
      continue;
    }
    if (!idleTimeoutElapsed(instance.idleSince, policy.idleTimeoutSeconds)) continue;
    // The worker status endpoint is the final safety barrier against stopping
    // during upload/webhook cleanup; no known active missions may remain.
    try {
      const drainResponse = await workerFetch(instance, '/api/v1/system/prepare-shutdown', { method: 'POST', body: '{}' }, 5000);
      const drainBody = await drainResponse.json() as { data?: { safeToStop?: boolean; queuedJobs?: number; activeJobs?: number } };
      if (!drainResponse.ok || !drainBody.data?.safeToStop) {
        await workerFetch(instance, '/api/v1/system/resume', { method: 'POST', body: '{}' }, 5000).catch(() => undefined);
        await updateInstance(instance.id, { idleSince: null });
        await record('INFO', 'instance.idle_stop_deferred', 'Worker reported local work during the shutdown barrier; idle termination was deferred', { vastInstanceId: instance.vastInstanceId, runtime: drainBody.data }, { instanceId: instance.id });
        continue;
      }
      if (!await beginIdleTermination(instance.id)) {
        await workerFetch(instance, '/api/v1/system/resume', { method: 'POST', body: '{}' }, 5000).catch(() => undefined);
        await updateInstance(instance.id, { idleSince: null });
        await record('INFO', 'instance.idle_stop_cancelled', 'Idle termination lost its final database safety check and was cancelled', {
          vastInstanceId: instance.vastInstanceId,
          reason: 'instance state changed or an active mission was assigned',
        }, { instanceId: instance.id });
        continue;
      }
      if (policy.idleAction === 'STOP') {
        await setInstanceState(instance.vastInstanceId, 'stopped');
        await updateInstance(instance.id, { state: 'STOPPED', healthStatus: 'OFFLINE', workerUrl: null, terminatedAt: new Date() });
      } else {
        await destroyInstance(instance.vastInstanceId);
        await updateInstance(instance.id, { state: 'DESTROYED', healthStatus: 'OFFLINE', workerUrl: null, terminatedAt: new Date() });
      }
      await record('INFO', 'instance.idle_terminated', `Idle instance ${policy.idleAction === 'STOP' ? 'stopped' : 'destroyed'}`, { vastInstanceId: instance.vastInstanceId, idleSeconds: policy.idleTimeoutSeconds, action: policy.idleAction }, { instanceId: instance.id });
    } catch (error) {
      await workerFetch(instance, '/api/v1/system/resume', { method: 'POST', body: '{}' }, 5000).catch(() => undefined);
      await updateInstance(instance.id, { state: 'RUNNING', lastError: error instanceof Error ? error.message : String(error) });
      await record('ERROR', 'instance.idle_termination_failed', 'Failed to stop an idle Vast instance; it remains under supervision', { vastInstanceId: instance.vastInstanceId, ...errorContext(error) }, { instanceId: instance.id });
    }
  }
}

async function reconcileOnce(): Promise<number> {
  let nextDelayMs = config.reconcileIntervalMs;
  const lock = await withOrchestratorLock(async () => {
    const policy = await getPolicy();
    if (!policy) { await record('FATAL', 'policy.missing', 'Supervisor policy row is missing; apply the MyTurn database migration and configure a Vast template'); return; }
    nextDelayMs = policy.healthPollSeconds * 1000;
    if (policy.workerLogRetentionDays > 0 && Date.now() - lastLogCleanupAt >= 60 * 60 * 1000) {
      lastLogCleanupAt = Date.now();
      try {
        const deleted = await cleanupWorkerLogs(policy.workerLogRetentionDays);
        if (deleted > 0) await record('INFO', 'worker_logs.retention_completed', 'Expired durable worker logs were removed', { deleted, retentionDays: policy.workerLogRetentionDays });
      } catch (error) {
        await record('ERROR', 'worker_logs.retention_failed', 'Worker log retention cleanup failed and will retry later', { retentionDays: policy.workerLogRetentionDays, ...errorContext(error) });
      }
    }
    const instances = await listManagedInstances();
    for (const instance of instances) await syncInstance(instance, policy);
    let refreshed = await listManagedInstances();
    await reconcileJobs(refreshed, policy);
    // reconcileJobs may replace an instance. Never dispatch using the fleet
    // snapshot captured before that replacement.
    refreshed = await listManagedInstances();
    if (!policy.enabled) { await stopIdleInstances(refreshed, policy); return; }

    for (const instance of refreshed.filter((item) => item.state === 'RUNNING' && item.healthStatus === 'HEALTHY')) {
      let active = await activeMissionCount(instance.id);
      while (active < policy.jobsPerWorker) {
        const mission = await claimMission(instance.id);
        if (!mission) break;
        await dispatch(instance, mission, policy);
        active += 1;
      }
    }

    const queued = await queuedMissionCount();
    const live = (await listManagedInstances()).filter((item) => ['PROVISIONING','RUNNING','STOPPED'].includes(item.state));
    const sleeping = live.find((item) => item.state === 'STOPPED');
    if (queued > 0 && sleeping) {
      try {
        await setInstanceState(sleeping.vastInstanceId, 'running');
        await updateInstance(sleeping.id, { state: 'PROVISIONING', healthStatus: 'STARTING', idleSince: null, terminatedAt: null });
        await record('INFO', 'instance.resume_requested', 'Queued work resumed a stopped Vast instance', { vastInstanceId: sleeping.vastInstanceId, queued }, { instanceId: sleeping.id });
      } catch (error) {
        await replaceInstance(sleeping, policy, `stopped instance could not resume: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (queued >= policy.queueDepthPerNewWorker && live.length < policy.maxWorkers) {
      try { await provision(policy); }
      catch (error) { await record('ERROR', 'instance.provision_failed', 'Unable to provision capacity for queued missions; queue remains durable and reconciliation will retry', { queued, liveWorkers: live.length, ...errorContext(error) }); }
    }
    await stopIdleInstances(await listManagedInstances(), policy);
  });
  if (!lock.acquired) {
    logger.debug({ event: 'orchestrator.lock_contended' }, 'Another supervisor reconciliation cycle currently owns the database lock');
  }
  return nextDelayMs;
}

export function wakeOrchestrator(reason: string): void {
  logger.info({ event: 'orchestrator.wakeup', reason }, 'Supervisor reconciliation requested');
  wakeups.emit('wake');
}

export function startOrchestrator(): void {
  if (loopPromise) return;
  stopped = false;
  loopPromise = (async () => {
    while (!stopped) {
      let nextDelayMs = config.reconcileIntervalMs;
      try { nextDelayMs = await reconcileOnce(); }
      catch (error) { await record('FATAL', 'orchestrator.cycle_failed', 'Unhandled supervisor reconciliation failure; the next cycle will retry', errorContext(error)); }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, nextDelayMs);
        function done() { clearTimeout(timer); wakeups.off('wake', done); resolve(); }
        wakeups.once('wake', done);
      });
    }
  })().finally(() => { loopPromise = undefined; });
}

export async function stopOrchestrator(): Promise<void> {
  stopped = true;
  wakeups.emit('wake');
  await loopPromise;
}
