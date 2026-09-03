export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SupervisorPolicy {
  enabled: boolean;
  maxHourlyPrice: number;
  verifiedOnly: boolean;
  datacenterOnly: boolean;
  requireFullMachine: boolean;
  allowedGpuModels: string[];
  minimumGpuRamMb: number;
  minimumCpuCores: number;
  minimumRamMb: number;
  minimumReliability: number;
  minimumDownloadMbps: number;
  minimumUploadMbps: number;
  diskGb: number;
  offerSearchLimit: number;
  maxWorkers: number;
  jobsPerWorker: number;
  queueDepthPerNewWorker: number;
  idleTimeoutSeconds: number;
  idleAction: 'STOP' | 'DESTROY';
  startupTimeoutSeconds: number;
  healthPollSeconds: number;
  maxInstanceFailures: number;
  maxMissionAttempts: number;
  missionTimeoutSeconds: number;
  workerLogRetentionDays: number;
  vastTemplateHash: string;
  policyVersion: number;
}

export interface WorkerLogInput {
  id: string;
  timestamp: Date;
  level: string;
  message: string;
  service: string;
  correlationId?: string;
  context?: Record<string, unknown>;
  jobId?: string;
  vastInstanceId?: number;
  instanceLabel?: string;
}

export interface VastOffer {
  id: number;
  machine_id?: number;
  dph_total?: number;
  gpu_name?: string;
  gpu_ram?: number;
  gpu_total_ram?: number;
  gpu_frac?: number;
  num_gpus?: number;
  cpu_cores?: number;
  cpu_cores_effective?: number;
  cpu_ram?: number;
  mem_limit?: number | null;
  reliability?: number;
  reliability2?: number;
  verification?: string;
  datacenter?: boolean;
  external?: boolean | null;
  vms_enabled?: boolean;
  inet_down?: number;
  inet_up?: number;
  dlperf_per_dphtotal?: number;
  rented?: boolean;
  rentable?: boolean;
  [key: string]: unknown;
}

export interface MachineClassification {
  fullMachine: boolean;
  cpu: { allocated: number; total: number; ratio: number; full: boolean };
  ram: { allocatedMb: number; totalMb: number; ratio: number; full: boolean; source: string };
  gpuFraction: number;
  vmFlag: boolean;
  reasons: string[];
}

export interface MissionRow {
  id: string;
  externalId: string;
  entityType: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  assignedInstanceId: string | null;
  dispatchedAt?: Date | null;
}

export interface InstanceRow {
  id: string;
  vastInstanceId: number;
  state: string;
  workerUrl: string | null;
  healthStatus: string;
  consecutiveFailures: number;
  idleSince: Date | null;
}
