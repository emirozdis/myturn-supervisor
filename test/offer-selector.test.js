const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyMachine, selectOffers } = require('../dist/offer-selector.js');

const policy = {
  enabled: true, maxHourlyPrice: 1, verifiedOnly: true, datacenterOnly: true, requireFullMachine: true,
  allowedGpuModels: ['RTX 4090'], minimumGpuRamMb: 20000, minimumCpuCores: 8, minimumRamMb: 32000,
  minimumReliability: 0.98, minimumDownloadMbps: 200, minimumUploadMbps: 100, diskGb: 20,
  offerSearchLimit: 100, maxWorkers: 1, jobsPerWorker: 1, queueDepthPerNewWorker: 1,
  idleTimeoutSeconds: 300, idleAction: 'DESTROY', startupTimeoutSeconds: 600, healthPollSeconds: 5,
  maxInstanceFailures: 3, maxMissionAttempts: 3, vastTemplateHash: 'hash', policyVersion: 1,
  workerLogRetentionDays: 30,
};

test('full-machine classification requires full CPU, RAM resource fraction, GPU and no VM flag', () => {
  const full = classifyMachine({ cpu_cores: 24, cpu_cores_effective: 24, cpu_ram: 65536, gpu_frac: 1, vms_enabled: false });
  assert.equal(full.fullMachine, true);
  const partialCpu = classifyMachine({ cpu_cores: 48, cpu_cores_effective: 24, cpu_ram: 131072, gpu_frac: 1, vms_enabled: false });
  assert.equal(partialCpu.fullMachine, false);
  assert.match(partialCpu.reasons.join(','), /partial-cpu:24\/48/);
  const partialRam = classifyMachine({ cpu_cores: 24, cpu_cores_effective: 24, cpu_ram: 131072, gpu_frac: 0.5, vms_enabled: false });
  assert.equal(partialRam.fullMachine, false);
  assert.match(partialRam.reasons.join(','), /partial-ram/);
});

test('offer selection enforces policy then selects the cheapest qualified offer', () => {
  const base = { gpu_name: 'RTX 4090', gpu_ram: 24576, cpu_cores: 16, cpu_cores_effective: 16, cpu_ram: 65536,
    gpu_frac: 1, vms_enabled: false, verification: 'verified', datacenter: true, reliability2: 0.995,
    inet_down: 1000, inet_up: 500, dph_total: 0.8 };
  const selected = selectOffers([
    { ...base, id: 1, dlperf_per_dphtotal: 5 },
    { ...base, id: 2, dph_total: 0.7, dlperf_per_dphtotal: 8 },
    { ...base, id: 3, cpu_cores_effective: 8, cpu_cores: 16, dlperf_per_dphtotal: 20 },
  ], policy);
  assert.deepEqual(selected.map((item) => item.offer.id), [2, 1]);
});

test('a cheaper qualified RTX 3060 outranks a faster RTX 5090', () => {
  const economicalPolicy = {
    ...policy,
    maxHourlyPrice: 0.4,
    allowedGpuModels: ['RTX 3060', 'RTX 5090'],
    minimumGpuRamMb: 7000,
    minimumCpuCores: 4,
    minimumRamMb: 12000,
    minimumReliability: 0.97,
  };
  const common = {
    gpu_frac: 1, vms_enabled: false, verification: 'verified', datacenter: true,
  };
  const selected = selectOffers([
    {
      ...common, id: 45669089, gpu_name: 'RTX 5090', gpu_ram: 32768,
      cpu_cores: 16, cpu_cores_effective: 16, cpu_ram: 31744,
      reliability2: 0.982, inet_down: 513, inet_up: 352,
      dph_total: 0.343, dlperf_per_dphtotal: 580.8,
    },
    {
      ...common, id: 46781973, gpu_name: 'RTX 3060', gpu_ram: 12288,
      cpu_cores: 12, cpu_cores_effective: 12, cpu_ram: 32768,
      reliability2: 0.9974, inet_down: 2116, inet_up: 1652,
      dph_total: 0.133, dlperf_per_dphtotal: 94.4,
    },
  ], economicalPolicy);

  assert.deepEqual(selected.map((item) => item.offer.id), [46781973, 45669089]);
});

test('equal-price offers use reliability, then DLPerf, then offer id as tie-breakers', () => {
  const base = {
    gpu_name: 'RTX 4090', gpu_ram: 24576, cpu_cores: 16, cpu_cores_effective: 16,
    cpu_ram: 65536, gpu_frac: 1, vms_enabled: false, verification: 'verified',
    datacenter: true, inet_down: 1000, inet_up: 500, dph_total: 0.5,
  };
  const selected = selectOffers([
    { ...base, id: 4, reliability2: 0.99, dlperf_per_dphtotal: 100 },
    { ...base, id: 3, reliability2: 0.995, dlperf_per_dphtotal: 10 },
    { ...base, id: 2, reliability2: 0.995, dlperf_per_dphtotal: 20 },
    { ...base, id: 1, reliability2: 0.995, dlperf_per_dphtotal: 20 },
  ], policy);

  assert.deepEqual(selected.map((item) => item.offer.id), [1, 2, 3, 4]);
});

test('offers with missing, zero, or non-finite prices are rejected', () => {
  const base = {
    gpu_name: 'RTX 4090', gpu_ram: 24576, cpu_cores: 16, cpu_cores_effective: 16,
    cpu_ram: 65536, gpu_frac: 1, vms_enabled: false, verification: 'verified',
    datacenter: true, reliability2: 0.995, inet_down: 1000, inet_up: 500,
  };
  const selected = selectOffers([
    { ...base, id: 1 },
    { ...base, id: 2, dph_total: 0 },
    { ...base, id: 3, dph_total: Number.POSITIVE_INFINITY },
    { ...base, id: 4, dph_total: 0.5 },
  ], policy);

  assert.deepEqual(selected.map((item) => item.offer.id), [4]);
});
