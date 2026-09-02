import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

export type ProviderAgentSelection = {
  schema_version: "provider-selection-v1";
  revision: number;
  state: "detected" | "selected";
  selected_models: string[];
};

export type ProviderAgentManifest = {
  protocol_version: "provider-agent-v1";
  state: "detected" | "selected" | "submitted";
  selected_models: string[];
  device_key_id?: string;
  device_public_key_spki?: string;
};

export type ProviderRelayShadowSessionRequest = {
  session_id: string;
  organization_id: string;
  provider_id: string;
  node_id: string;
  credential_epoch: number;
  relay_id: string;
  region: string;
  transport: "outbound_mtls" | "tailscale_private";
};

export type SignedProviderRelayShadowSession = {
  envelopeVersion: "multivibe-provider-relay-envelope-v1";
  kind: "relay_session_open";
  payload: Record<string, unknown> & {
    shadowOnly: true;
    customerTrafficAllowed: false;
    routingEligible: false;
    compensationEligible: false;
  };
  signature: { algorithm: "Ed25519"; keyId: string; value: string };
};

export const PROVIDER_RUNTIME_FAMILIES = [
  "ollama", "lm-studio", "llama-cpp", "vllm", "sglang", "localai",
  "huggingface-tgi", "transformers-serve", "xinference", "mlx-lm", "omlx",
  "mlc-llm", "exo", "jan", "gpt4all", "koboldcpp", "text-generation-webui",
  "aphrodite", "tabbyapi", "llama-box", "mistral-rs", "nvidia-nim",
  "tensorrt-llm", "triton", "openllm", "bentoml", "mtplx", "manual-openai-compatible",
] as const;

export type ProviderRuntimeFamily = typeof PROVIDER_RUNTIME_FAMILIES[number];

const PROVIDER_RUNTIME_FAMILY_SET = new Set<string>(PROVIDER_RUNTIME_FAMILIES);

export type ProviderCloudEnrollmentRequest = {
  enrollment_token: string;
  core_version: string;
  runtime_family: ProviderRuntimeFamily;
  selected_models: Array<{ reported_id: string; modalities: string[] }>;
  declared_max_concurrency: number;
};

export type ProviderCloudEnrollmentView = {
  schema_version: "provider-cloud-enrollment-v1";
  revision: 1;
  state: "submitted";
  provider_id: string;
  node_id: string;
  device_key_id: string;
  credential_epoch: number;
  manifest_digest: string;
  runtime_family: ProviderRuntimeFamily;
  declared_max_concurrency: number;
  cloud_api_origin: string;
  submitted_at: string;
  routing_eligible: false;
  compensation_eligible: false;
  safety_profile: "shadow_only_no_routing_no_compensation";
};

export type ProviderAgentDetectedModels = {
  schema_version: "provider-detected-models-v1";
  runtimes: Array<{ adapter_id: string; models: string[] }>;
};

export type ProviderAgentRuntimeEndpointInput = {
  adapter_id: string;
  endpoint: string;
  bearer_token?: string;
};

export type ProviderAgentRuntimeEndpoints = {
  schema_version: "provider-runtime-endpoints-v1";
  revision: number;
  endpoints: Array<{
    adapter_id: string;
    endpoint: string;
    authentication: "none" | "bearer";
  }>;
};

export type ProviderAgentAdapterRegistry = {
  schema_version: "provider-runtime-registry-v2";
  adapters: Array<{
    id: string;
    display_name: string;
    protocol: "openai-compatible" | "native";
    authentication: "none" | "optional-bearer" | "required-bearer";
    automatic_loopback_candidates: Array<{ endpoint: string }>;
  }>;
};

export type ProviderCapacityPolicy = {
  schema_version: "provider-capacity-policy-state-v1";
  revision: number;
  paused: boolean;
  automatic_downloads: boolean;
  allow_cloud_workloads: boolean;
  policy: {
    schema_version: "provider-capacity-policy-v1";
    gpu_utilization_percent: number;
    gpu_vram_percent: number;
    max_disk_bytes: number;
    model_storage_path: string;
    max_download_bytes_per_day: number;
    minimum_model_residency_seconds: number;
    max_model_changes_per_day: number;
    reserve_free_disk_bytes: number;
  };
};

export type ProviderDemandPlan = {
  schema_version: "provider-demand-plan-state-v1";
  generation: number;
  envelope_digest: string;
  signing_key_id: string;
  accepted_at: string;
  plan: {
    schema_version: "provider-model-plan-v1";
    demand_revision: number;
    model_storage_path: string;
    selected_model_ids: string[];
    downloads: Array<{ model_id: string; bytes: number }>;
    gpu_utilization_percent: number;
    gpu_vram_bytes: number;
    additional_disk_bytes: number;
    model_change: boolean;
    model_change_deferred: boolean;
    constraints: Array<{ model_id?: string; reason: string }>;
  };
};

export type ProviderManagedOllamaView = {
  schema_version: "provider-managed-controller-view-v1";
  state: string;
  operation?: string;
  head_generation: number;
  head_envelope_digest?: string;
  applied_generation: number;
  applied_envelope_digest?: string;
  applied_policy_revision: number;
  policy_revision: number;
  selected_model_ids: string[];
  shadow_only: true;
  customer_traffic_allowed: false;
  routing_eligible: false;
  compensation_eligible: false;
  runtime: {
    schema_version: "managed-ollama-status-v1";
    state: string;
    version: string;
    platform: "darwin-arm64" | "linux-amd64";
    runtime_installed: boolean;
    running: boolean;
    paused: boolean;
    installed_model_ids: string[];
  };
};

export type ProviderManagedOllamaReconcileFence = {
  policy_revision: number;
  plan_generation: number;
  envelope_digest: string;
};

export type ProviderAgentControl = {
  enabled: boolean;
  getManifest(): Promise<ProviderAgentManifest>;
  getSelection(): Promise<ProviderAgentSelection>;
  replaceSelection(revision: number, selectedModels: string[]): Promise<{ conflict: boolean; selection: ProviderAgentSelection }>;
  getAdapters(): Promise<ProviderAgentAdapterRegistry>;
  getRuntimeEndpoints(): Promise<ProviderAgentRuntimeEndpoints>;
  replaceRuntimeEndpoints(revision: number, endpoints: ProviderAgentRuntimeEndpointInput[]): Promise<{ conflict: boolean; endpoints: ProviderAgentRuntimeEndpoints }>;
  detectModels(): Promise<ProviderAgentDetectedModels>;
  getCloudEnrollment(): Promise<ProviderCloudEnrollmentView>;
  enrollCloud(request: ProviderCloudEnrollmentRequest): Promise<ProviderCloudEnrollmentView>;
  getCapacityPolicy(): Promise<ProviderCapacityPolicy>;
  replaceCapacityPolicy(policy: ProviderCapacityPolicy): Promise<{ conflict: boolean; policy: ProviderCapacityPolicy | null }>;
  getDemandPlan(): Promise<ProviderDemandPlan>;
  submitSignedDemand(envelope: Record<string, unknown>): Promise<{ duplicate: boolean; plan: ProviderDemandPlan }>;
  getManagedOllamaStatus(): Promise<ProviderManagedOllamaView>;
  installManagedOllama(policyRevision: number): Promise<ProviderManagedOllamaView>;
  startManagedOllama(policyRevision: number): Promise<ProviderManagedOllamaView>;
  stopManagedOllama(): Promise<ProviderManagedOllamaView>;
  reconcileManagedOllama(fence: ProviderManagedOllamaReconcileFence): Promise<ProviderManagedOllamaView>;
  openRelayShadowSession(request: ProviderRelayShadowSessionRequest): Promise<SignedProviderRelayShadowSession>;
};

export type ProviderAgentSupervisor = ProviderAgentControl & { stop(): Promise<void> };

export class ProviderAgentControlRequestError extends Error {
  constructor(readonly status: number) {
    super("provider agent control request was rejected");
  }
}

const PROVIDER_AGENT_BOOTSTRAP_FD = 3;
const PROVIDER_AGENT_BOOTSTRAP_MAX_BYTES = 512;
const PROVIDER_AGENT_BOOTSTRAP_TIMEOUT_MS = 30_000;
const PROVIDER_AGENT_BOOTSTRAP_PROTOCOL = "provider-agent-bootstrap-v1";

export function providerAgentBootstrapBaseUrl(frame: string): string {
  if (Buffer.byteLength(frame) > PROVIDER_AGENT_BOOTSTRAP_MAX_BYTES ||
    !frame.endsWith("\n") || frame.slice(0, -1).includes("\n") || frame.includes("\r")) {
    throw new Error("provider agent bootstrap frame is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(frame.slice(0, -1));
  } catch {
    throw new Error("provider agent bootstrap frame is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider agent bootstrap frame is invalid");
  }
  const announcement = value as Record<string, unknown>;
  const keys = Object.keys(announcement).sort();
  if (keys.length !== 2 || keys[0] !== "address" || keys[1] !== "protocol_version" ||
    announcement.protocol_version !== PROVIDER_AGENT_BOOTSTRAP_PROTOCOL ||
    typeof announcement.address !== "string") {
    throw new Error("provider agent bootstrap frame is invalid");
  }
  const match = /^(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(announcement.address);
  const port = match ? Number(match[1]) : 0;
  if (!match || !Number.isSafeInteger(port) || port > 65_535 || port === 1460 || String(port) !== match[1]) {
    throw new Error("provider agent bootstrap address is invalid");
  }
  const canonicalFrame = JSON.stringify({
    protocol_version: PROVIDER_AGENT_BOOTSTRAP_PROTOCOL,
    address: announcement.address,
  }) + "\n";
  if (frame !== canonicalFrame) throw new Error("provider agent bootstrap frame is not canonical");
  return `http://${announcement.address}`;
}

export function readProviderAgentBootstrap(
  stream: Readable,
  timeoutMs = PROVIDER_AGENT_BOOTSTRAP_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(new Error("provider agent bootstrap timed out")), timeoutMs);
    timer.unref();

    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += value.byteLength;
      if (totalBytes > PROVIDER_AGENT_BOOTSTRAP_MAX_BYTES) {
        fail(new Error("provider agent bootstrap frame is too large"));
        return;
      }
      chunks.push(value);
    };
    const onEnd = () => {
      if (settled) return;
      let frame: string;
      try {
        frame = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        fail(new Error("provider agent bootstrap frame is invalid"));
        return;
      }
      try {
        const baseUrl = providerAgentBootstrapBaseUrl(frame);
        settled = true;
        cleanup();
        resolve(baseUrl);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("provider agent bootstrap frame is invalid"));
      }
    };
    const onError = () => fail(new Error("provider agent bootstrap pipe failed"));
    const onClose = () => {
      if (!settled && !stream.readableEnded) fail(new Error("provider agent bootstrap pipe closed early"));
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

const PROVIDER_AGENT_ENVIRONMENT_KEYS = [
  "MULTIVIBE_CORE_LOOPBACK_URL",
  "MULTIVIBE_PROVIDER_AGENT_LISTEN",
  "MULTIVIBE_PROVIDER_SELECTED_MODELS",
] as const;

export function providerAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PROVIDER_AGENT_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function providerAgentChildEnvironment(
  source: NodeJS.ProcessEnv,
  statePath: string | undefined,
  controlToken: string,
  runtimeStatePath?: string,
  deviceKeyPath?: string,
  enrollmentStatePath?: string,
  capacityPolicyPath?: string,
  cloudApiUrl?: string,
  demandPlanPath?: string,
  modelCatalogPath?: string,
  trustedDemandKeys?: string,
  managedRoot?: string,
  bundledOllamaRoot?: string,
  dependencyManifestPath?: string,
  managedPlannerStatePath?: string,
  ollamaListen?: string,
  cudaVisibleDevices?: string,
  supervisedListenAddress?: "127.0.0.1:0" | "[::1]:0",
  bootstrapFD?: number,
): NodeJS.ProcessEnv {
  return {
    ...providerAgentEnvironment(source),
    ...(statePath ? { MULTIVIBE_PROVIDER_STATE_PATH: statePath } : {}),
    ...(runtimeStatePath ? { MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH: runtimeStatePath } : {}),
    ...(deviceKeyPath ? { MULTIVIBE_PROVIDER_DEVICE_KEY_PATH: deviceKeyPath } : {}),
    ...(enrollmentStatePath ? { MULTIVIBE_PROVIDER_ENROLLMENT_STATE_PATH: enrollmentStatePath } : {}),
    ...(capacityPolicyPath ? { MULTIVIBE_PROVIDER_CAPACITY_POLICY_PATH: capacityPolicyPath } : {}),
    ...(cloudApiUrl ? { MULTIVIBE_CLOUD_API_URL: cloudApiUrl } : {}),
    ...(demandPlanPath ? { MULTIVIBE_PROVIDER_DEMAND_PLAN_PATH: demandPlanPath } : {}),
    ...(modelCatalogPath ? { MULTIVIBE_PROVIDER_MODEL_CATALOG_PATH: modelCatalogPath } : {}),
    ...(trustedDemandKeys ? { MULTIVIBE_PROVIDER_DEMAND_TRUSTED_KEYS: trustedDemandKeys } : {}),
    ...(managedRoot ? { MULTIVIBE_PROVIDER_MANAGED_ROOT: managedRoot } : {}),
    ...(bundledOllamaRoot ? { MULTIVIBE_PROVIDER_BUNDLED_OLLAMA_ROOT: bundledOllamaRoot } : {}),
    ...(dependencyManifestPath ? { MULTIVIBE_PROVIDER_DEPENDENCY_MANIFEST_PATH: dependencyManifestPath } : {}),
    ...(managedPlannerStatePath ? { MULTIVIBE_PROVIDER_MANAGED_PLANNER_STATE_PATH: managedPlannerStatePath } : {}),
    ...(ollamaListen ? { MULTIVIBE_PROVIDER_OLLAMA_LISTEN: ollamaListen } : {}),
    ...(cudaVisibleDevices ? { MULTIVIBE_PROVIDER_CUDA_VISIBLE_DEVICES: cudaVisibleDevices } : {}),
    ...(supervisedListenAddress ? { MULTIVIBE_PROVIDER_AGENT_LISTEN: supervisedListenAddress } : {}),
    ...(bootstrapFD !== undefined ? { MULTIVIBE_PROVIDER_BOOTSTRAP_FD: String(bootstrapFD) } : {}),
    MULTIVIBE_PROVIDER_CONTROL_TOKEN: controlToken,
  };
}

export function isValidProviderSelectedModelId(model: unknown): model is string {
  if (typeof model !== "string" || model.length === 0 || Buffer.byteLength(model) > 200
    || model.trim() !== model || model.includes("\\")
    || /[A-Za-z][A-Za-z0-9+.-]*:\//.test(model) || model.startsWith("/")
    || /^[A-Za-z]:\//.test(model) || /\p{Cc}/u.test(model)) return false;
  return model.split("/").every((segment) => {
    if (segment === "." || segment === ".." || isIP(segment) !== 0) return false;
    if (segment.startsWith("[") && segment.endsWith("]") && isIP(segment.slice(1, -1)) !== 0) return false;
    return true;
  });
}

export function isValidProviderRuntimeEndpointInput(
  value: unknown,
): value is ProviderAgentRuntimeEndpointInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !["adapter_id", "endpoint", "bearer_token"].includes(key))) return false;
  if (typeof input.adapter_id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.adapter_id)) return false;
  if (typeof input.endpoint !== "string" || input.endpoint.length > 256 || input.endpoint.trim() !== input.endpoint) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    return false;
  }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")
    || !endpoint.port || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)) return false;
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  if (input.bearer_token !== undefined) {
    if (typeof input.bearer_token !== "string" || Buffer.byteLength(input.bearer_token) > 4096
      || /\p{Cc}/u.test(input.bearer_token)) return false;
  }
  return true;
}

export function isValidProviderRelayShadowSessionRequest(
  value: unknown,
): value is ProviderRelayShadowSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = [
    "session_id", "organization_id", "provider_id", "node_id", "credential_epoch",
    "relay_id", "region", "transport",
  ];
  if (Object.keys(request).length !== keys.length || keys.some((key) => !(key in request))) return false;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
  for (const key of ["session_id", "organization_id", "provider_id", "node_id", "relay_id", "region"]) {
    if (typeof request[key] !== "string" || !identifier.test(request[key])) return false;
  }
  if (!Number.isSafeInteger(request.credential_epoch)
    || (request.credential_epoch as number) < 1
    || (request.credential_epoch as number) > 2 ** 48 - 1) return false;
  return request.transport === "outbound_mtls" || request.transport === "tailscale_private";
}

export function isValidProviderCloudEnrollmentRequest(
  value: unknown,
): value is ProviderCloudEnrollmentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = ["enrollment_token", "core_version", "runtime_family", "selected_models", "declared_max_concurrency"];
  if (Object.keys(request).length !== keys.length || keys.some((key) => !(key in request))) return false;
  if (typeof request.enrollment_token !== "string" || !/^mve_[A-Za-z0-9_-]{43}$/.test(request.enrollment_token)) return false;
  if (typeof request.core_version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,63}$/.test(request.core_version)) return false;
  if (!PROVIDER_RUNTIME_FAMILY_SET.has(String(request.runtime_family))) return false;
  if (!Number.isSafeInteger(request.declared_max_concurrency)
    || (request.declared_max_concurrency as number) < 1 || (request.declared_max_concurrency as number) > 1_000) return false;
  if (!Array.isArray(request.selected_models) || request.selected_models.length < 1 || request.selected_models.length > 100) return false;
  const ids = new Set<string>();
  for (const value of request.selected_models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const model = value as Record<string, unknown>;
    if (Object.keys(model).length !== 2 || !("reported_id" in model) || !("modalities" in model)
      || !isValidProviderSelectedModelId(model.reported_id) || ids.has(model.reported_id)) return false;
    ids.add(model.reported_id);
    if (!Array.isArray(model.modalities) || model.modalities.length < 1 || model.modalities.length > 16
      || new Set(model.modalities).size !== model.modalities.length
      || model.modalities.some((modality) => typeof modality !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,31}$/.test(modality))) return false;
  }
  return true;
}

export function isValidProviderCapacityPolicy(value: unknown): value is ProviderCapacityPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  const fields = ["schema_version", "revision", "paused", "automatic_downloads", "allow_cloud_workloads", "policy"];
  if (Object.keys(document).length !== fields.length || fields.some((field) => !(field in document)) ||
    document.schema_version !== "provider-capacity-policy-state-v1" ||
    !Number.isSafeInteger(document.revision) || (document.revision as number) < 0 ||
    typeof document.paused !== "boolean" || typeof document.automatic_downloads !== "boolean" ||
    typeof document.allow_cloud_workloads !== "boolean" || !document.policy ||
    typeof document.policy !== "object" || Array.isArray(document.policy)) return false;
  const policy = document.policy as Record<string, unknown>;
  const policyFields = [
    "schema_version", "gpu_utilization_percent", "gpu_vram_percent", "max_disk_bytes",
    "model_storage_path", "max_download_bytes_per_day", "minimum_model_residency_seconds",
    "max_model_changes_per_day", "reserve_free_disk_bytes",
  ];
  if (Object.keys(policy).length !== policyFields.length || policyFields.some((field) => !(field in policy)) ||
    policy.schema_version !== "provider-capacity-policy-v1") return false;
  const boundedPercent = (field: string) => Number.isSafeInteger(policy[field]) &&
    (policy[field] as number) >= 1 && (policy[field] as number) <= 100;
  const nonNegativeInteger = (field: string) => Number.isSafeInteger(policy[field]) && (policy[field] as number) >= 0;
  if (!boundedPercent("gpu_utilization_percent") || !boundedPercent("gpu_vram_percent") ||
    !nonNegativeInteger("max_disk_bytes") || (policy.max_disk_bytes as number) < 1 ||
    !nonNegativeInteger("max_download_bytes_per_day") ||
    !nonNegativeInteger("minimum_model_residency_seconds") || (policy.minimum_model_residency_seconds as number) < 1 ||
    !nonNegativeInteger("max_model_changes_per_day") ||
    !nonNegativeInteger("reserve_free_disk_bytes") || (policy.reserve_free_disk_bytes as number) < 1 ||
    typeof policy.model_storage_path !== "string" || policy.model_storage_path.length < 2 ||
    policy.model_storage_path.length > 4096 || /[\0\r\n]/u.test(policy.model_storage_path)) return false;
  return path.isAbsolute(policy.model_storage_path) && path.normalize(policy.model_storage_path) === policy.model_storage_path;
}

function providerCloudApiUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("provider Cloud API URL is invalid"); }
  const production = parsed.protocol === "https:" && parsed.host === "api.multivibe.cloud";
  const loopback = parsed.protocol === "http:" && Boolean(parsed.port) && ["127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((!production && !loopback) || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) throw new Error("provider Cloud API URL is invalid");
  return parsed.origin;
}

export function startEmbeddedProviderAgent(options: {
  enabled: boolean;
  binaryPath: string;
  environment?: NodeJS.ProcessEnv;
  statePath?: string;
  runtimeStatePath?: string;
  deviceKeyPath?: string;
  enrollmentStatePath?: string;
  capacityPolicyPath?: string;
  cloudApiUrl?: string;
  demandPlanPath?: string;
  modelCatalogPath?: string;
  trustedDemandKeys?: string;
  managedRoot?: string;
  bundledOllamaRoot?: string;
  dependencyManifestPath?: string;
  managedPlannerStatePath?: string;
  ollamaListen?: string;
  cudaVisibleDevices?: string;
  restartLimit?: number;
}): ProviderAgentSupervisor {
  const unavailable = async (): Promise<never> => { throw new Error("provider agent is not enabled"); };
  if (!options.enabled) return {
    enabled: false,
    stop: async () => undefined,
    getManifest: unavailable,
    getSelection: unavailable,
    replaceSelection: unavailable,
    getAdapters: unavailable,
    getRuntimeEndpoints: unavailable,
    replaceRuntimeEndpoints: unavailable,
    detectModels: unavailable,
    getCloudEnrollment: unavailable,
    enrollCloud: unavailable,
    getCapacityPolicy: unavailable,
    replaceCapacityPolicy: unavailable,
    getDemandPlan: unavailable,
    submitSignedDemand: unavailable,
    getManagedOllamaStatus: unavailable,
    installManagedOllama: unavailable,
    startManagedOllama: unavailable,
    stopManagedOllama: unavailable,
    reconcileManagedOllama: unavailable,
    openRelayShadowSession: unavailable,
  };
  if (!path.isAbsolute(options.binaryPath)) throw new Error("provider agent binary path must be absolute");
  if (options.statePath && (!path.isAbsolute(options.statePath) || path.normalize(options.statePath) !== options.statePath)) {
    throw new Error("provider agent state path must be a clean absolute path");
  }
  if (options.runtimeStatePath && (!path.isAbsolute(options.runtimeStatePath)
    || path.normalize(options.runtimeStatePath) !== options.runtimeStatePath)) {
    throw new Error("provider agent runtime state path must be a clean absolute path");
  }
  if (options.deviceKeyPath && (!path.isAbsolute(options.deviceKeyPath)
    || path.normalize(options.deviceKeyPath) !== options.deviceKeyPath)) {
    throw new Error("provider agent device key path must be a clean absolute path");
  }
  if (options.enrollmentStatePath && (!path.isAbsolute(options.enrollmentStatePath)
    || path.normalize(options.enrollmentStatePath) !== options.enrollmentStatePath)) {
    throw new Error("provider agent enrollment state path must be a clean absolute path");
  }
  if (options.capacityPolicyPath && (!path.isAbsolute(options.capacityPolicyPath)
    || path.normalize(options.capacityPolicyPath) !== options.capacityPolicyPath)) {
    throw new Error("provider agent capacity policy path must be a clean absolute path");
  }
  const demandConfiguration = [options.demandPlanPath, options.modelCatalogPath, options.trustedDemandKeys];
  const demandConfigurationCount = demandConfiguration.filter((value) => Boolean(value)).length;
  if (demandConfigurationCount !== 0 && demandConfigurationCount !== demandConfiguration.length) {
    throw new Error("provider demand planning requires plan path, model catalog and trusted keys");
  }
  for (const configuredPath of [options.demandPlanPath, options.modelCatalogPath]) {
    if (configuredPath && (!path.isAbsolute(configuredPath) || path.normalize(configuredPath) !== configuredPath)) {
      throw new Error("provider demand planning paths must be clean absolute paths");
    }
  }
  if (options.trustedDemandKeys && Buffer.byteLength(options.trustedDemandKeys) > 64 * 1024) {
    throw new Error("provider demand trusted keys are too large");
  }
  const managedConfiguration = [
    options.managedRoot,
    options.bundledOllamaRoot,
    options.dependencyManifestPath,
    options.managedPlannerStatePath,
  ];
  const managedConfigurationCount = managedConfiguration.filter((value) => Boolean(value)).length;
  if ((managedConfigurationCount !== 0 && managedConfigurationCount !== managedConfiguration.length) ||
    (managedConfigurationCount === managedConfiguration.length && !options.modelCatalogPath)) {
    throw new Error("managed provider runtime requires every local path");
  }
  for (const configuredPath of [
    options.managedRoot,
    options.bundledOllamaRoot,
    options.dependencyManifestPath,
    options.managedPlannerStatePath,
  ]) {
    if (configuredPath && (!path.isAbsolute(configuredPath) || path.normalize(configuredPath) !== configuredPath)) {
      throw new Error("managed provider runtime paths must be clean absolute paths");
    }
  }
  const cloudApiUrl = providerCloudApiUrl(options.cloudApiUrl ?? "https://api.multivibe.cloud");
  const sourceEnvironment = options.environment ?? process.env;
  const configuredListenAddress = sourceEnvironment.MULTIVIBE_PROVIDER_AGENT_LISTEN ?? "127.0.0.1:1460";
  if (configuredListenAddress !== "127.0.0.1:1460" && configuredListenAddress !== "[::1]:1460") {
    throw new Error("provider agent listen address must use literal loopback port 1460");
  }
  const supervisedListenAddress: "127.0.0.1:0" | "[::1]:0" =
    configuredListenAddress === "[::1]:1460" ? "[::1]:0" : "127.0.0.1:0";
  type ActiveLaunch = {
    process: ChildProcess;
    controlToken: string;
    ready: Promise<string>;
    abortController: AbortController;
  };
  let child: ChildProcess | undefined;
  let activeLaunch: ActiveLaunch | undefined;
  let stopped = false;
  let restarts = 0;
  const restartLimit = options.restartLimit ?? 5;

  const currentEndpoint = async (): Promise<{ baseUrl: string; launch: ActiveLaunch }> => {
    const launch = activeLaunch;
    if (!launch) throw new Error("provider agent is unavailable");
    const baseUrl = await launch.ready;
    if (activeLaunch !== launch || launch.process.exitCode !== null || launch.process.killed) {
      throw new Error("provider agent is unavailable");
    }
    return { baseUrl, launch };
  };
  const request = async <T>(
    route: string,
    init: RequestInit = {},
    acceptedStatuses: readonly number[] = [200, 409],
    timeoutMs = 3_000,
  ): Promise<{ response: Response; value: T }> => {
    const { baseUrl, launch } = await currentEndpoint();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${launch.controlToken}`);
    const signals = [AbortSignal.timeout(timeoutMs), launch.abortController.signal];
    if (init.signal) signals.push(init.signal);
    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    if (!acceptedStatuses.includes(response.status)) {
      if ([400, 404, 409].includes(response.status)) throw new ProviderAgentControlRequestError(response.status);
      throw new Error("provider agent control request failed");
    }
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > 64 * 1024) throw new Error("provider agent control response is too large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("provider agent control response is too large");
    return { response, value: JSON.parse(text) as T };
  };

  const launch = () => {
    if (stopped) return;
    const controlToken = randomBytes(32).toString("base64url");
    const spawned = spawn(options.binaryPath, [], {
      env: providerAgentChildEnvironment(
        sourceEnvironment, options.statePath, controlToken, options.runtimeStatePath, options.deviceKeyPath,
        options.enrollmentStatePath, options.capacityPolicyPath, cloudApiUrl,
        options.demandPlanPath, options.modelCatalogPath, options.trustedDemandKeys,
        options.managedRoot, options.bundledOllamaRoot, options.dependencyManifestPath,
        options.managedPlannerStatePath, options.ollamaListen, options.cudaVisibleDevices,
        supervisedListenAddress, PROVIDER_AGENT_BOOTSTRAP_FD,
      ),
      shell: false,
      stdio: ["ignore", "inherit", "inherit", "pipe"],
    });
    child = spawned;
    const abortController = new AbortController();
    const bootstrapStream = spawned.stdio[PROVIDER_AGENT_BOOTSTRAP_FD] as Readable | null;
    let rejectProcessFailure: (reason: Error) => void = () => undefined;
    const processFailure = new Promise<never>((_resolve, reject) => {
      rejectProcessFailure = reject;
    });
    const bootstrap = bootstrapStream
      ? readProviderAgentBootstrap(bootstrapStream)
      : Promise.reject(new Error("provider agent bootstrap pipe is unavailable"));
    let state: ActiveLaunch;
    const ready = Promise.race([bootstrap, processFailure]).then((baseUrl) => {
      if (activeLaunch !== state || spawned.exitCode !== null || spawned.killed) {
        throw new Error("provider agent exited during bootstrap");
      }
      return baseUrl;
    });
    state = { process: spawned, controlToken, ready, abortController };
    activeLaunch = state;

    let failureHandled = false;
    const handleFailure = () => {
      if (failureHandled) return;
      failureHandled = true;
      rejectProcessFailure(new Error("provider agent exited"));
      abortController.abort();
      if (activeLaunch === state) activeLaunch = undefined;
      if (child === spawned) child = undefined;
      if (!stopped && restarts < restartLimit) {
        restarts += 1;
        setTimeout(launch, Math.min(1_000 * restarts, 5_000)).unref();
      }
    };
    spawned.once("error", handleFailure);
    spawned.once("exit", handleFailure);
    void ready.catch(() => {
      if (activeLaunch === state && spawned.exitCode === null && !spawned.killed) {
        spawned.kill("SIGKILL");
      }
    });
  };
  launch();
  return {
    enabled: true,
    getManifest: async () => (await request<ProviderAgentManifest>("/v1/manifest")).value,
    getSelection: async () => (await request<ProviderAgentSelection>("/v1/selection")).value,
    replaceSelection: async (revision, selectedModels) => {
      const result = await request<ProviderAgentSelection>("/v1/selection", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, selected_models: selectedModels }),
      });
      return { conflict: result.response.status === 409, selection: result.value };
    },
    getAdapters: async () => (await request<ProviderAgentAdapterRegistry>("/v1/adapters")).value,
    getRuntimeEndpoints: async () => (await request<ProviderAgentRuntimeEndpoints>("/v1/runtime-endpoints")).value,
    replaceRuntimeEndpoints: async (revision, endpoints) => {
      const result = await request<ProviderAgentRuntimeEndpoints>("/v1/runtime-endpoints", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, endpoints }),
      });
      return { conflict: result.response.status === 409, endpoints: result.value };
    },
    detectModels: async () => (await request<ProviderAgentDetectedModels>("/v1/detected-models")).value,
    getCloudEnrollment: async () => (await request<ProviderCloudEnrollmentView>("/v1/cloud-shadow/enrollment", {}, [200])).value,
    enrollCloud: async (enrollment) => (await request<ProviderCloudEnrollmentView>("/v1/cloud-shadow/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(enrollment),
    }, [201])).value,
    getCapacityPolicy: async () => (await request<ProviderCapacityPolicy>("/v1/capacity-policy", {}, [200])).value,
    replaceCapacityPolicy: async (policy) => {
      const result = await request<ProviderCapacityPolicy | null>("/v1/capacity-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      });
      return { conflict: result.response.status === 409, policy: result.value };
    },
    getDemandPlan: async () => (await request<ProviderDemandPlan>("/v1/cloud-shadow/demand-plan", {}, [200])).value,
    submitSignedDemand: async (envelope) => {
      const encoded = JSON.stringify(envelope);
      if (Buffer.byteLength(encoded) > 64 * 1024) throw new ProviderAgentControlRequestError(400);
      const result = await request<ProviderDemandPlan>("/v1/cloud-shadow/demand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encoded,
      }, [200, 201]);
      return { duplicate: result.response.status === 200, plan: result.value };
    },
    getManagedOllamaStatus: async () =>
      (await request<ProviderManagedOllamaView>("/v1/managed-ollama/status", {}, [200])).value,
    installManagedOllama: async (policyRevision) =>
      (await request<ProviderManagedOllamaView>("/v1/managed-ollama/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy_revision: policyRevision }),
      }, [200], 2 * 60 * 60 * 1_000 + 30_000)).value,
    startManagedOllama: async (policyRevision) =>
      (await request<ProviderManagedOllamaView>("/v1/managed-ollama/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy_revision: policyRevision }),
      }, [200], 30_000)).value,
    stopManagedOllama: async () =>
      (await request<ProviderManagedOllamaView>("/v1/managed-ollama/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }, [200], 30_000)).value,
    reconcileManagedOllama: async (fence) =>
      (await request<ProviderManagedOllamaView>("/v1/managed-ollama/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fence),
      }, [200], 2 * 60 * 60 * 1_000 + 30_000)).value,
    openRelayShadowSession: async (session) => (await request<SignedProviderRelayShadowSession>("/v1/relay-shadow/session-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(session),
    })).value,
    stop: async () => {
      stopped = true;
      const running = child;
      if (!running || running.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 5_000);
        timeout.unref();
        running.once("exit", () => { clearTimeout(timeout); resolve(); });
        running.kill("SIGTERM");
      });
    },
  };
}
