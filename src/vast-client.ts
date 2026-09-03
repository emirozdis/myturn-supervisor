import { config } from './config';
import { SupervisorPolicy, VastOffer } from './types';

const baseUrl = 'https://console.vast.ai';

async function vastRequest(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.vastApiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Vast ${init.method || 'GET'} ${path} returned HTTP ${response.status}: ${text.slice(0, 1500)}`);
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`Vast ${path} returned invalid JSON`); }
}

export async function searchOffers(policy: SupervisorPolicy): Promise<VastOffer[]> {
  const body: Record<string, unknown> = {
    limit: policy.offerSearchLimit,
    type: 'ondemand',
    rentable: { eq: true },
    rented: { eq: false },
    dph_total: { lte: policy.maxHourlyPrice },
    gpu_ram: { gte: policy.minimumGpuRamMb },
    cpu_cores_effective: { gte: policy.minimumCpuCores },
    cpu_ram: { gte: policy.minimumRamMb },
    reliability: { gte: policy.minimumReliability },
    inet_down: { gte: policy.minimumDownloadMbps },
    inet_up: { gte: policy.minimumUploadMbps },
    order: [['dph_total', 'asc']],
  };
  if (policy.verifiedOnly) body.verified = { eq: true };
  if (policy.datacenterOnly) body.datacenter = { eq: true };
  if (policy.allowedGpuModels.length) body.gpu_name = { in: policy.allowedGpuModels };
  const data = await vastRequest('/api/v0/bundles/', { method: 'POST', body: JSON.stringify(body) });
  const raw = data.offers;
  return Array.isArray(raw) ? raw as VastOffer[] : raw && typeof raw === 'object' ? [raw as VastOffer] : [];
}

export async function createInstance(offerId: number, policy: SupervisorPolicy): Promise<number> {
  const data = await vastRequest(`/api/v0/asks/${offerId}/`, {
    method: 'PUT',
    body: JSON.stringify({
      template_hash_id: policy.vastTemplateHash,
      disk: policy.diskGb,
      label: `myturn-transcoder-${Date.now()}`,
      target_state: 'running',
      cancel_unavail: true,
      runtype: 'args',
    }),
  }, 30_000);
  const id = Number(data.new_contract);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Vast create instance response did not include a valid contract ID');
  return id;
}

export async function showInstance(instanceId: number): Promise<Record<string, unknown>> {
  const data = await vastRequest(`/api/v0/instances/${instanceId}/`);
  const instance = data.instances;
  if (!instance || typeof instance !== 'object') throw new Error(`Vast instance ${instanceId} response is missing instance data`);
  return instance as Record<string, unknown>;
}

export async function setInstanceState(instanceId: number, state: 'running' | 'stopped'): Promise<void> {
  await vastRequest(`/api/v0/instances/${instanceId}/`, { method: 'PUT', body: JSON.stringify({ state }) });
}

export async function destroyInstance(instanceId: number): Promise<void> {
  try {
    await vastRequest(`/api/v0/instances/${instanceId}/`, { method: 'DELETE' });
  } catch (error) {
    // A missing contract already satisfies the desired destroyed state.
    if (error instanceof Error && error.message.includes('HTTP 404')) return;
    throw error;
  }
}

export type VastInstanceStatusDisposition = 'RUNNING' | 'STOPPED' | 'TERMINAL' | 'TRANSITIONAL';

export function classifyInstanceStatus(status: unknown): VastInstanceStatusDisposition {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'running') return 'RUNNING';
  if (normalized === 'stopped') return 'STOPPED';
  if (['exited', 'offline'].includes(normalized)) return 'TERMINAL';

  // Vast can briefly report "unknown" (and other non-terminal startup states)
  // after accepting a contract but before the container is ready. These must
  // remain under supervision until startupTimeoutSeconds expires.
  return 'TRANSITIONAL';
}

export function resolveWorkerUrl(instance: Record<string, unknown>): string | null {
  const publicIp = typeof instance.public_ipaddr === 'string' ? instance.public_ipaddr : '';
  const ports = instance.ports as Record<string, Array<{ HostPort?: string }>> | undefined;
  const mapped = ports?.['3000/tcp']?.[0]?.HostPort;
  if (!publicIp || !mapped || !/^\d{1,5}$/.test(mapped)) return null;
  return `http://${publicIp}:${mapped}`;
}
