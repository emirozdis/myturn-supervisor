import { MachineClassification, SupervisorPolicy, VastOffer } from './types';

const FULL_RATIO = 0.98;

export function classifyMachine(offer: VastOffer): MachineClassification {
  const totalCpu = Math.max(0, Number(offer.cpu_cores || 0));
  const allocatedCpu = Math.max(0, Number(offer.cpu_cores_effective ?? offer.cpu_cores ?? 0));
  const cpuRatio = totalCpu > 0 ? Math.min(1, allocatedCpu / totalCpu) : 0;
  const gpuFraction = Math.max(0, Math.min(1, Number(offer.gpu_frac ?? 1)));
  const totalRamMb = Math.max(0, Number(offer.cpu_ram || 0));
  // Vast exposes host RAM plus either mem_limit on some responses or the GPU
  // resource fraction. Preserve the evidence so classification is auditable.
  const explicitLimitMb = Number(offer.mem_limit || 0) > 0 ? Number(offer.mem_limit) * 1024 : 0;
  const allocatedRamMb = explicitLimitMb || totalRamMb * gpuFraction;
  const ramRatio = totalRamMb > 0 ? Math.min(1, allocatedRamMb / totalRamMb) : 0;
  const cpuFull = cpuRatio >= FULL_RATIO;
  const ramFull = ramRatio >= FULL_RATIO;
  const vmFlag = offer.vms_enabled === true;
  const reasons: string[] = [];
  if (!cpuFull) reasons.push(`partial-cpu:${allocatedCpu}/${totalCpu}`);
  if (!ramFull) reasons.push(`partial-ram:${Math.round(allocatedRamMb)}/${totalRamMb}MB`);
  if (gpuFraction < FULL_RATIO) reasons.push(`partial-gpu:${gpuFraction}`);
  if (vmFlag) reasons.push('vast-vms-enabled');
  return {
    fullMachine: cpuFull && ramFull && gpuFraction >= FULL_RATIO && !vmFlag,
    cpu: { allocated: allocatedCpu, total: totalCpu, ratio: cpuRatio, full: cpuFull },
    ram: { allocatedMb: allocatedRamMb, totalMb: totalRamMb, ratio: ramRatio, full: ramFull, source: explicitLimitMb ? 'mem_limit' : 'cpu_ram*gpu_frac' },
    gpuFraction,
    vmFlag,
    reasons,
  };
}

export function selectOffers(offers: VastOffer[], policy: SupervisorPolicy): Array<{ offer: VastOffer; classification: MachineClassification }> {
  return offers.flatMap((offer) => {
    const classification = classifyMachine(offer);
    const price = Number(offer.dph_total);
    const reliability = Number(offer.reliability2 ?? offer.reliability ?? 0);
    const gpuName = String(offer.gpu_name || '');
    const passes = Number.isFinite(price)
      && price > 0
      && price <= policy.maxHourlyPrice
      && Number(offer.gpu_ram || 0) >= policy.minimumGpuRamMb
      && Number(offer.cpu_cores_effective ?? 0) >= policy.minimumCpuCores
      && classification.ram.allocatedMb >= policy.minimumRamMb
      && reliability >= policy.minimumReliability
      && Number(offer.inet_down || 0) >= policy.minimumDownloadMbps
      && Number(offer.inet_up || 0) >= policy.minimumUploadMbps
      && (!policy.verifiedOnly || offer.verification === 'verified')
      // The search API applies the datacenter filter server-side. `external`
      // is null for some datacenter offers, so only an explicit true is unsafe.
      && (!policy.datacenterOnly || offer.datacenter === true || offer.external !== true)
      && (policy.allowedGpuModels.length === 0 || policy.allowedGpuModels.includes(gpuName))
      && (!policy.requireFullMachine || classification.fullMachine);
    if (!passes) return [];
    return [{ offer, classification }];
  }).sort((left, right) => {
    // GPU suitability is expressed by the policy's exact model allowlist and
    // hard resource requirements. Once an offer qualifies, extra DLPerf does
    // not represent meaningful value for the NVENC/NVDEC HLS workload.
    const priceDifference = Number(left.offer.dph_total) - Number(right.offer.dph_total);
    if (priceDifference !== 0) return priceDifference;

    const leftReliability = Number(left.offer.reliability2 ?? left.offer.reliability ?? 0);
    const rightReliability = Number(right.offer.reliability2 ?? right.offer.reliability ?? 0);
    const reliabilityDifference = rightReliability - leftReliability;
    if (reliabilityDifference !== 0) return reliabilityDifference;

    // DLPerf/$ is retained only as a deterministic tie-breaker for offers
    // having exactly the same hourly price and reliability.
    const performanceDifference = Number(right.offer.dlperf_per_dphtotal || 0)
      - Number(left.offer.dlperf_per_dphtotal || 0);
    if (performanceDifference !== 0) return performanceDifference;
    return left.offer.id - right.offer.id;
  });
}
