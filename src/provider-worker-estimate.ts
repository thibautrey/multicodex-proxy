import type { ProviderHostCapability } from "./provider-agent-supervisor.js";

export type ProviderWorkerEarningsEstimate = {
  currency: "USD";
  period: "month";
  amount: string;
  basis: "same_chip" | "fleet_median" | "no_observations" | "catalog_unavailable";
  sample_count: number;
  as_of_date?: string;
  disclaimer: string;
};

export type ProviderWorkerEstimateClient = {
  estimate(capability: ProviderHostCapability): Promise<ProviderWorkerEarningsEstimate>;
};

type HardwareCohort = {
  profile: "apple-silicon" | "linux-nvidia";
  accelerator: "metal" | "cuda";
  chip: string;
  memory_bucket_gib: number;
  estimated_monthly_usd: string;
  sample_count: number;
};

type HardwareEstimateCatalog = {
  schema_version: "provider-hardware-earnings-estimates-v1";
  currency: "USD";
  period: "month";
  generated_at: string;
  as_of_date: string;
  observation_window_days: number;
  minimum_sample_size: number;
  cohorts: HardwareCohort[];
  fallback: {
    basis: "fleet_median" | "no_observations";
    estimated_monthly_usd: string;
    sample_count: number;
  };
  disclaimer: string;
};

const MAX_CATALOG_BYTES = 256 * 1024;
const FALLBACK_DISCLAIMER =
  "Advisory estimate only. It is not earned, guaranteed, payable, or an offer to provide workloads.";

function normalizeChip(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function canonicalMoney(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/u.test(value)) return undefined;
  return Number(value).toFixed(2);
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function readCatalog(value: unknown): HardwareEstimateCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("estimate catalog is invalid");
  const document = value as Record<string, unknown>;
  if (document.schema_version !== "provider-hardware-earnings-estimates-v1" ||
      document.currency !== "USD" || document.period !== "month" ||
      typeof document.generated_at !== "string" || !Number.isFinite(Date.parse(document.generated_at)) ||
      typeof document.as_of_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(document.as_of_date) ||
      !safeInteger(document.observation_window_days, 1, 366) ||
      !safeInteger(document.minimum_sample_size, 3, 10_000) ||
      !Array.isArray(document.cohorts) || document.cohorts.length > 2_000 ||
      typeof document.disclaimer !== "string" || document.disclaimer.length < 20 || document.disclaimer.length > 500) {
    throw new Error("estimate catalog is invalid");
  }
  const fallback = document.fallback as Record<string, unknown> | undefined;
  if (!fallback || !["fleet_median", "no_observations"].includes(String(fallback.basis)) ||
      !canonicalMoney(fallback.estimated_monthly_usd) || !safeInteger(fallback.sample_count, 0, 10_000_000)) {
    throw new Error("estimate catalog fallback is invalid");
  }
  const minimumSampleSize = document.minimum_sample_size as number;
  if (fallback.basis === "fleet_median" && (fallback.sample_count as number) < minimumSampleSize) {
    throw new Error("estimate catalog fallback sample is too small");
  }
  if (fallback.basis === "no_observations" &&
      (fallback.sample_count !== 0 || canonicalMoney(fallback.estimated_monthly_usd) !== "0.00")) {
    throw new Error("estimate catalog empty fallback is invalid");
  }
  for (const item of document.cohorts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("estimate cohort is invalid");
    const cohort = item as Record<string, unknown>;
    if (!["apple-silicon", "linux-nvidia"].includes(String(cohort.profile)) ||
        !["metal", "cuda"].includes(String(cohort.accelerator)) ||
        (cohort.profile === "apple-silicon" ? cohort.accelerator !== "metal" : cohort.accelerator !== "cuda") ||
        typeof cohort.chip !== "string" || cohort.chip.trim() !== cohort.chip || cohort.chip.length < 2 || cohort.chip.length > 120 ||
        /[\u0000-\u001f\u007f]/u.test(cohort.chip) ||
        !safeInteger(cohort.memory_bucket_gib, 1, 2_048) ||
        !canonicalMoney(cohort.estimated_monthly_usd) ||
        !safeInteger(cohort.sample_count, minimumSampleSize, 10_000_000)) {
      throw new Error("estimate cohort is invalid");
    }
  }
  return document as unknown as HardwareEstimateCatalog;
}

function capabilityChip(capability: ProviderHostCapability): string | undefined {
  if (capability.profile === "apple-silicon" && capability.accelerator === "metal") {
    return capability.hardware_model?.trim() || undefined;
  }
  if (capability.profile === "linux-nvidia" && capability.accelerator === "cuda") {
    const selected = capability.cuda_device ?? 0;
    return capability.gpus?.[selected]?.name.trim() || undefined;
  }
  return undefined;
}

export function estimateProviderWorkerEarnings(
  capability: ProviderHostCapability,
  input: unknown,
): ProviderWorkerEarningsEstimate {
  const catalog = readCatalog(input);
  const chip = capabilityChip(capability);
  const memoryGiB = Math.max(0, Math.round((capability.accelerator_memory_bytes ?? 0) / (1024 ** 3)));
  const matching = chip ? catalog.cohorts
    .filter((cohort) => cohort.profile === capability.profile &&
      cohort.accelerator === capability.accelerator && normalizeChip(cohort.chip) === normalizeChip(chip))
    .sort((left, right) => Math.abs(left.memory_bucket_gib - memoryGiB) - Math.abs(right.memory_bucket_gib - memoryGiB)) : [];
  const cohort = matching[0];
  if (cohort) {
    return {
      currency: "USD",
      period: "month",
      amount: canonicalMoney(cohort.estimated_monthly_usd)!,
      basis: "same_chip",
      sample_count: cohort.sample_count,
      as_of_date: catalog.as_of_date,
      disclaimer: catalog.disclaimer,
    };
  }
  return {
    currency: "USD",
    period: "month",
    amount: canonicalMoney(catalog.fallback.estimated_monthly_usd)!,
    basis: catalog.fallback.basis,
    sample_count: catalog.fallback.sample_count,
    as_of_date: catalog.as_of_date,
    disclaimer: catalog.disclaimer,
  };
}

export function unavailableProviderWorkerEstimate(): ProviderWorkerEarningsEstimate {
  return {
    currency: "USD",
    period: "month",
    amount: "0.00",
    basis: "catalog_unavailable",
    sample_count: 0,
    disclaimer: FALLBACK_DISCLAIMER,
  };
}

export function createProviderWorkerEstimateClient(
  cloudApiUrl: string,
  fetcher: typeof fetch = fetch,
): ProviderWorkerEstimateClient {
  const origin = new URL(cloudApiUrl);
  const production = origin.protocol === "https:" && origin.host === "api.multivibe.cloud";
  const loopback = origin.protocol === "http:" && Boolean(origin.port) && ["127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((!production && !loopback) || origin.username || origin.password || origin.search || origin.hash ||
      (origin.pathname !== "/" && origin.pathname !== "")) {
    throw new Error("provider earnings estimate API URL is invalid");
  }
  const endpoint = new URL("/provider/v1/public/hardware-earnings-estimates", origin.origin).toString();
  return {
    async estimate(capability) {
      const response = await fetcher(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok || response.url && response.url !== endpoint) throw new Error("estimate catalog is unavailable");
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_CATALOG_BYTES) throw new Error("estimate catalog is too large");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_CATALOG_BYTES) throw new Error("estimate catalog is too large");
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new Error("estimate catalog is invalid"); }
      return estimateProviderWorkerEarnings(capability, value);
    },
  };
}
